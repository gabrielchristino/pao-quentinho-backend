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

app.post('/api/subscribe', async (req, res) => {
  const { subscription, estabelecimentoId } = req.body;
  console.log(`➡️  POST /api/subscribe para o estabelecimento ${estabelecimentoId}`);

  try {
    // 1. Insere a inscrição se ela não existir e retorna o ID dela.
    const upsertSubscriptionQuery = `
      INSERT INTO subscriptions (subscription_data) VALUES ($1)
      ON CONFLICT (subscription_data) DO UPDATE SET subscription_data = EXCLUDED.subscription_data
      RETURNING id;
    `;
    const subResult = await pool.query(upsertSubscriptionQuery, [subscription]);
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
                icon: 'https://gabriel-nt.github.io/pao-quentinho/assets/icons/icon-192x192.png',
                vibrate: [100, 50, 100],
                data: {
                    url: `https://gabriel-nt.github.io/pao-quentinho/estabelecimento/${estabelecimentoId}` 
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
      const proximaFornada = est.details.proximaFornada;
      // traz o horário
      console.log(`[CRON] Estabelecimento ${est.id} (${est.nome}) - Próxima fornada: ${proximaFornada}`);

      // Ignora se não houver horário de fornada
      if (!proximaFornada || proximaFornada === 'N/A') {
        continue;
      }

      const [fornadaHours, fornadaMinutes] = proximaFornada.split(':').map(Number);
      const fornadaTotalMinutes = (fornadaHours * 60) + fornadaMinutes;
      console.log(`[CRON] Estabelecimento ${est.id} (${est.nome}) - Fornada às ${fornadaHours}:${fornadaMinutes} (${fornadaTotalMinutes} min do dia)`);

      // Calcula os minutos desde a meia-noite para os horários de notificação
      const notification1hBefore = fornadaTotalMinutes - 60; // 1 hora antes
      const notification5minBefore = fornadaTotalMinutes - 5;   // 5 minutos antes

      // Verifica se o minuto atual está na janela de algum dos horários de notificação
      // A janela de 5 minutos (ex: `+ 5`) é para garantir que a notificação seja pega pelo cron que roda a cada 5 min.
      const shouldNotify1h = currentMinutesSinceMidnight >= notification1hBefore && currentMinutesSinceMidnight < notification1hBefore + 5;
      const shouldNotify5min = currentMinutesSinceMidnight >= notification5minBefore && currentMinutesSinceMidnight < notification5minBefore + 5;

      if (shouldNotify1h || shouldNotify5min) {
        console.log(`🔥 Hora de notificar para a fornada das ${proximaFornada} no estabelecimento ${est.id} (${est.nome})!`);
        
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
            : `Uma nova fornada sairá às ${proximaFornada}. Não perca!`;

          console.log(`[CRON] Mensagem selecionada para notificação: "${randomMessage}"`);

          const notificationPayload = {
            notification: {
              title: isAlmostTime ? `Está saindo agora em ${est.nome}!` : `Falta 1h para a fornada em ${est.nome}!`,
              body: randomMessage,
              icon: 'https://gabriel-nt.github.io/pao-quentinho/assets/icons/icon-192x192.png',
              data: {
                url: `https://gabriel-nt.github.io/pao-quentinho/estabelecimento/${est.id}`
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
