// index.js

// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

// Log para depuração da variável de ambiente do banco de dados
console.log(`[ENV] DATABASE_URL status: ${process.env.DATABASE_URL ? 'Encontrada' : 'NÃO ENCONTRADA'}`);

const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg'); // Importa o driver do PostgreSQL
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// --- Configuração do Banco de Dados ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Usa a URL fornecida pelo Railway
  ssl: {
    rejectUnauthorized: false // Necessário para conexões SSL em ambientes como Railway/Heroku
  }
});

// Middlewares
app.use(cors());
app.use(express.json());

// --- Configuração das Notificações Push ---
// As chaves são lidas das variáveis de ambiente do Railway
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:seu-email@exemplo.com', // Um email de contato
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('✅ Configuração do Web Push realizada com sucesso.');
} else {
  console.warn("⚠️ Chaves VAPID não configuradas. O envio de notificações está desabilitado.");
}

// --- Rotas da API ---

// Rota para fornecer a chave pública VAPID para o frontend
app.get('/api/vapid-public-key', (req, res) => {
  console.log('➡️  GET /api/vapid-public-key');
  res.status(200).send(VAPID_PUBLIC_KEY);
});

app.get('/api/estabelecimentos', async (req, res) => {
  const userLat = parseFloat(req.query.lat);
  const userLng = parseFloat(req.query.lng);

  console.log(`➡️  GET /api/estabelecimentos para lat: ${userLat}, lng: ${userLng}`);

  try {
    const result = await pool.query('SELECT id, nome, tipo, latitude, longitude, details FROM estabelecimentos');
    console.log(`[DB] Encontrados ${result.rowCount} estabelecimentos.`);
    
    // Remonta o objeto completo que o frontend espera
    let estabelecimentos = result.rows.map(row => ({
      id: row.id,
      nome: row.nome,
      tipo: row.tipo,
      latitude: row.latitude,
      longitude: row.longitude,
      ...row.details // Combina com os detalhes do JSONB (horario, endereco, etc.)
    }));
    
    // Se as coordenadas do usuário foram fornecidas, calcula a distância
    if (!isNaN(userLat) && !isNaN(userLng)) {
      const estabelecimentosComDistancia = estabelecimentos.map(est => {
        const distanciaKm = calculateDistance(userLat, userLng, est.latitude, est.longitude);
        return { ...est, distanciaKm };
      });
      // Ordena pela distância
      res.status(200).json(estabelecimentosComDistancia.sort((a, b) => a.distanciaKm - b.distanciaKm));
    } else {
      // Retorna a lista sem distância se as coordenadas não forem fornecidas
      res.status(200).json(estabelecimentos);
    }
  } catch (err) {
    console.error('❌ Erro ao buscar estabelecimentos:', err.stack);
    res.status(500).json({ message: 'Erro ao buscar estabelecimentos.' });
  }
});

app.get('/api/estabelecimentos/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`➡️  GET /api/estabelecimentos/${id}`);

  try {
    const result = await pool.query('SELECT id, nome, tipo, latitude, longitude, details FROM estabelecimentos WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Estabelecimento não encontrado.' });
    }

    const row = result.rows[0];
    // Remonta o objeto completo que o frontend espera
    const estabelecimento = {
      id: row.id,
      nome: row.nome,
      tipo: row.tipo,
      latitude: row.latitude,
      longitude: row.longitude,
      ...row.details
    };

    res.status(200).json(estabelecimento);
  } catch (err) {
    console.error(`❌ Erro ao buscar o estabelecimento ${id}:`, err.stack);
    res.status(500).json({ message: 'Erro ao buscar o estabelecimento.' });
  }
});

// Middleware para rotas que exigem autenticação
const authRequired = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ message: 'Token de autenticação não fornecido.' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Token mal formatado.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
};

app.post('/api/estabelecimentos', authRequired, async (req, res) => {
  console.log('➡️  POST /api/estabelecimentos - Criando novo estabelecimento...');
  const { nome, tipo, latitude, longitude, details } = req.body;
  const userId = req.user.userId; // Pega o ID do usuário logado (do token)

  // Validação básica dos dados recebidos
  if (!nome || !tipo || !latitude || !longitude || !details) {
    return res.status(400).json({ message: 'Dados incompletos para o cadastro.' });
  }
  try {
    const insertQuery = `
      INSERT INTO estabelecimentos (nome, tipo, latitude, longitude, details, user_id) 
      VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [nome, tipo, latitude, longitude, details, userId]);
    const novoEstabelecimento = result.rows[0];

    // Remonta o objeto para a resposta, similar ao GET
    const responseEstabelecimento = {
      id: novoEstabelecimento.id,
      nome: novoEstabelecimento.nome,
      tipo: novoEstabelecimento.tipo,
      latitude: novoEstabelecimento.latitude,
      longitude: novoEstabelecimento.longitude,
      ...novoEstabelecimento.details
    };

    console.log(`✅ Estabelecimento "${nome}" (ID: ${novoEstabelecimento.id}) criado com sucesso.`);
    res.status(201).json(responseEstabelecimento);
  } catch (err) {
    console.error('❌ Erro ao criar novo estabelecimento:', err.stack);
    res.status(500).json({ message: 'Erro ao salvar o estabelecimento no banco de dados.' });
  }
});


// --- ROTAS DE USUÁRIO LOGADO ---

// Rota para buscar os estabelecimentos de um usuário logado
app.get('/api/users/me/estabelecimentos', authRequired, async (req, res) => {
  const userId = req.user.userId;
  console.log(`➡️  GET /api/users/me/estabelecimentos para o usuário ${userId}`);

  try {
    const result = await pool.query('SELECT id, nome, tipo, latitude, longitude, details FROM estabelecimentos WHERE user_id = $1 ORDER BY id DESC', [userId]);

    // Remonta o objeto completo que o frontend espera
    const estabelecimentos = result.rows.map(row => ({
      id: row.id,
      nome: row.nome,
      tipo: row.tipo,
      latitude: row.latitude,
      longitude: row.longitude,
      ...row.details
    }));

    res.status(200).json(estabelecimentos);
  } catch (err) {
    console.error(`❌ Erro ao buscar estabelecimentos do usuário ${userId}:`, err.stack);
    res.status(500).json({ message: 'Erro ao buscar seus estabelecimentos.' });
  }
});

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Nome, email e senha são obrigatórios.' });
  }

  try {
    // Criptografa a senha
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, name, password_hash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Código '23505' é erro de violação de unicidade no PostgreSQL
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Este email já está em uso.' });
    }
    console.error('❌ Erro no registro:', err.stack);
    res.status(500).json({ message: 'Erro ao registrar usuário.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Credenciais inválidas.' }); // Usuário não encontrado
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ message: 'Credenciais inválidas.' }); // Senha incorreta
    }

    // Gera o token JWT
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token });

  } catch (err) {
    console.error('❌ Erro no login:', err.stack);
    res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

// --- Middleware para autenticação opcional ---
// Este middleware verifica se há um token, decodifica-o e anexa o usuário à requisição (req.user).
// Se não houver token, ele simplesmente continua, permitindo o acesso anônimo.
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return next(); // Nenhum token, continua como anônimo
  }

  const token = authHeader.split(' ')[1]; // Formato "Bearer TOKEN"
  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Anexa os dados do usuário (ex: { userId: 1, email: '...' })
  } catch (err) {
    // Token inválido ou expirado, ignora e continua como anônimo
    console.warn('Token inválido recebido:', err.message);
  }
  next();
};


app.post('/api/subscribe', optionalAuth, async (req, res) => {
  const { subscription, estabelecimentoId } = req.body;
  const userId = req.user?.userId || null; // Pega o ID do usuário do middleware, ou null se for anônimo

  console.log(`➡️  POST /api/subscribe para o estabelecimento ${estabelecimentoId} (Usuário: ${userId || 'Anônimo'})`);

  try {
    // 1. Insere a inscrição se ela não existir e retorna o ID dela.
    const upsertSubscriptionQuery = `
      INSERT INTO subscriptions (subscription_data, user_id) VALUES ($1, $2)
      ON CONFLICT (subscription_data) DO UPDATE SET subscription_data = EXCLUDED.subscription_data
      RETURNING id;
    `;
    const subResult = await pool.query(upsertSubscriptionQuery, [subscription, userId]);
    const subscriptionId = subResult.rows[0].id;

    // 2. Cria a ligação entre a inscrição e o estabelecimento.
    const linkQuery = `
      INSERT INTO establishment_subscriptions (subscription_id, estabelecimento_id) VALUES ($1, $2)
      ON CONFLICT (subscription_id, estabelecimento_id) DO NOTHING;
    `;
    await pool.query(linkQuery, [subscriptionId, estabelecimentoId]);

    res.status(201).json({ message: 'Inscrição realizada com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao salvar inscrição:', err.stack);
    res.status(500).json({ message: 'Erro ao salvar inscrição.' });
  }
});

app.post('/api/notify/:estabelecimentoId', async (req, res) => {
    const { estabelecimentoId } = req.params;
    const { message, title } = req.body || {}; // Garante que req.body não seja nulo

    console.log(`➡️  POST /api/notify/${estabelecimentoId} - Disparando notificação manual...`);

    try {
        // Busca as inscrições para um estabelecimento específico, fazendo o JOIN com a tabela de junção
        const query = `
          SELECT s.subscription_data
          FROM subscriptions s
          JOIN establishment_subscriptions es ON s.id = es.subscription_id
          WHERE es.estabelecimento_id = $1;
        `;
        const result = await pool.query(query, [estabelecimentoId]);
        const subscriptions = result.rows.map(row => row.subscription_data);

        if (subscriptions.length === 0) {
          console.log(`[NOTIFY] Nenhum inscrito encontrado para o estabelecimento ${estabelecimentoId}.`);
          return res.status(200).json({ message: 'Nenhum inscrito encontrado para este estabelecimento.' });
        }

        let notificationBody = message;

        // Se nenhuma mensagem foi enviada no corpo da requisição, busca uma aleatória no banco
        if (!notificationBody) {
          console.log('[NOTIFY] Nenhuma mensagem fornecida. Buscando mensagem aleatória no banco de dados...');
          const messagesResult = await pool.query('SELECT message FROM notification_messages');
          const randomMessages = messagesResult.rows;

          if (randomMessages.length > 0) {
            notificationBody = randomMessages[Math.floor(Math.random() * randomMessages.length)].message;
            console.log(`[NOTIFY] Mensagem aleatória selecionada: "${notificationBody}"`);
          }
        }

        const notificationPayload = {
            notification: {
                title: title || 'Pão Quentinho!',
                body: notificationBody || 'Uma nova fornada acabou de sair! Venha conferir!', // Fallback final
                icon: 'assets/icons/icon-192x192.png',
                // A propriedade 'data' é crucial para o Service Worker do Angular (ngsw)
                // saber como agir quando a notificação é clicada com o app fechado.
                data: {
                  onActionClick: {
                    default: {
                      operation: 'navigateLastFocusedOrOpen',
                      url: `/estabelecimento/${estabelecimentoId}`
                    }
                  }
                }
            }
        };

        const promises = subscriptions.map(sub =>
            webpush.sendNotification(sub, JSON.stringify(notificationPayload))
        );

        // Usamos Promise.allSettled para lidar com sucessos e falhas individualmente
        const results = await Promise.allSettled(promises);

        // Limpeza de inscrições expiradas
        results.forEach((result, index) => {
          if (result.status === 'rejected' && result.reason.statusCode === 410) {
            const expiredSubscription = subscriptions[index];
            const endpoint = expiredSubscription.endpoint;
            console.log(`🗑️  Inscrição expirada detectada. Removendo do banco de dados: ${endpoint}`);
            // A cláusula ON DELETE CASCADE no banco de dados cuidará de remover as entradas na tabela de junção.
            pool.query("DELETE FROM subscriptions WHERE subscription_data->>'endpoint' = $1", [endpoint])
              .catch(err => console.error(`❌ Erro ao remover inscrição expirada: ${err.stack}`));
          }
        });

        console.log(`✅ Notificações manuais enviadas para ${subscriptions.length} inscritos.`);
        res.status(200).json({ message: `Notificações enviadas para ${subscriptions.length} inscritos.` });
    } catch (err) {
        console.error("❌ Erro ao enviar notificações manuais:", err);
        res.status(500).json({ message: 'Erro ao enviar notificações.' });
    }
});

// Função para testar a conexão com o banco de dados com tentativas
const connectWithRetry = async (retries = 5, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      console.log('✅ [DB] Conexão com o banco de dados estabelecida com sucesso.');
      client.release(); // Libera o cliente de volta para o pool
      return;
    } catch (err) {
      console.error(`❌ Erro ao conectar ao banco de dados (tentativa ${i + 1}):`, err.message);
      if (i < retries - 1) {
        console.log(`Tentando novamente em ${delay / 1000} segundos...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        throw new Error('Não foi possível conectar ao banco de dados após várias tentativas.');
      }
    }
  }
};

/**
 * Função que verifica as próximas fornadas e dispara notificações.
 * Esta função será agendada para rodar a cada 15 minutos.
 */
const checkFornadasAndNotify = async () => {
  console.log('⏰ [CRON] Verificando fornadas agendadas...');

  try {
    const result = await pool.query('SELECT id, nome, details FROM estabelecimentos');
    const estabelecimentos = result.rows;
    // traz o resultado da consulta
    console.log(`[DB] Encontrados ${estabelecimentos.length} estabelecimentos.`);

    // Otimização: Busca todas as mensagens aleatórias de uma vez, fora do loop
    const messagesResult = await pool.query('SELECT message FROM notification_messages');
    const randomMessages = messagesResult.rows;
    console.log(`[DB] Encontradas ${randomMessages.length} mensagens de notificação.`);

    // Obtém a hora e os minutos atuais de forma robusta no fuso horário de São Paulo.
    const now = new Date();
    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);

    const currentHours = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10);
    const currentMinutes = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10);
    const currentMinutesSinceMidnight = (currentHours * 60) + currentMinutes;

    for (const est of estabelecimentos) {
      const fornadas = est.details.proximaFornada;

      // Ignora se não houver horário de fornada
      if (!fornadas || fornadas.length === 0) {
        continue;
      }

      // Itera sobre cada horário de fornada cadastrado
      for (const fornadaTime of fornadas) {
        // Garante que estamos lidando com uma string antes de usar .split()
        if (typeof fornadaTime === 'string') {
          const [fornadaHours, fornadaMinutes] = fornadaTime.split(':').map(Number);
          const fornadaTotalMinutes = (fornadaHours * 60) + fornadaMinutes;
          console.log(`[CRON] Estabelecimento ${est.id} (${est.nome}) - Verificando fornada das ${fornadaTime} (${fornadaTotalMinutes} min do dia)`);

          // Calcula os minutos desde a meia-noite para os horários de notificação
          const notification1hBefore = fornadaTotalMinutes - 60; // 1 hora antes
          const notification5minBefore = fornadaTotalMinutes - 5;   // 5 minutos antes

          // Verifica se o minuto atual está na janela de algum dos horários de notificação
          // A janela de 5 minutos (ex: `+ 5`) é para garantir que a notificação seja pega pelo cron que roda a cada 5 min.
          const shouldNotify1h = currentMinutesSinceMidnight >= notification1hBefore && currentMinutesSinceMidnight < notification1hBefore + 5;
          const shouldNotify5min = currentMinutesSinceMidnight >= notification5minBefore && currentMinutesSinceMidnight < notification5minBefore + 5;

          if (shouldNotify1h || shouldNotify5min) {
            console.log(`🔥 Hora de notificar para a fornada das ${fornadaTime} no estabelecimento ${est.id} (${est.nome})!`);
            
            const isAlmostTime = shouldNotify5min;

            // Busca as inscrições para o estabelecimento específico
            const subscriptionsQuery = `
              SELECT s.subscription_data
              FROM subscriptions s
              JOIN establishment_subscriptions es ON s.id = es.subscription_id
              WHERE es.estabelecimento_id = $1;
            `;
            const subscriptionsResult = await pool.query(subscriptionsQuery, [est.id]);
            const subscriptions = subscriptionsResult.rows.map(row => row.subscription_data);
            console.log(`[CRON] Encontradas ${subscriptions.length} inscrições para o estabelecimento ${est.id}.`);

            if (subscriptions.length > 0) {
              // Seleciona uma mensagem aleatória da lista já buscada
              const randomMessage = randomMessages.length > 0
                ? randomMessages[Math.floor(Math.random() * randomMessages.length)].message.replace('Pão quentinho', 'Pão quentinho saindo')
                : `Uma nova fornada sairá às ${fornadaTime}. Não perca!`;

              console.log(`[CRON] Mensagem selecionada para notificação: "${randomMessage}"`);

              const notificationPayload = {
                notification: {
                  title: isAlmostTime ? `Está saindo agora em ${est.nome}!` : `Falta 1h para a fornada em ${est.nome}!`,
                  body: randomMessage,
                  icon: 'assets/icons/icon-192x192.png',
                  // A propriedade 'data' é crucial para o Service Worker do Angular (ngsw)
                  data: {
                    onActionClick: {
                      default: { operation: 'navigateLastFocusedOrOpen', url: `/estabelecimento/${est.id}` }
                    }
                  }
                }
              };

              console.log(`[CRON] Enviando notificações para ${subscriptions.length} inscritos do estabelecimento ${est.id}...`);

              const promises = subscriptions.map(sub =>
                webpush.sendNotification(sub, JSON.stringify(notificationPayload))
              );

              const results = await Promise.allSettled(promises);

              results.forEach((result, index) => {
                if (result.status === 'rejected' && result.reason.statusCode === 410) {
                  const expiredSubscription = subscriptions[index];
                  const endpoint = expiredSubscription.endpoint;
                  console.log(`🗑️  [CRON] Inscrição expirada detectada. Removendo: ${endpoint}`);
                  pool.query("DELETE FROM subscriptions WHERE subscription_data->>'endpoint' = $1", [endpoint])
                    .catch(err => console.error(`❌ [CRON] Erro ao remover inscrição expirada: ${err.stack}`));
                }
              });
              console.log(`✅ Notificações enviadas para ${subscriptions.length} inscritos do estabelecimento ${est.id}.`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ [CRON] Erro ao verificar fornadas:', err);
  }
};

/**
 * Calcula a distância em KM entre duas coordenadas geográficas usando a fórmula de Haversine.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distância em km
}

/**
 * Converte graus para radianos.
 */
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// --- Inicialização do Servidor ---
const startServer = async () => {
  try {
    // Validação "Fail-Fast": Garante que variáveis essenciais existam antes de continuar.
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL não foi encontrada nas variáveis de ambiente.');
    }

    await connectWithRetry();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Servidor iniciado e rodando na porta ${PORT}`);

      // Agenda a verificação de fornadas para rodar a cada 5 minutos.
      cron.schedule('*/5 * * * *', checkFornadasAndNotify, { timezone: "America/Sao_Paulo" });
    });
  } catch (err) {
    console.error('🔥 Falha ao iniciar o servidor:', err.message);
    process.exit(1); // Encerra a aplicação se não conseguir conectar ao DB
  }
};

startServer();
