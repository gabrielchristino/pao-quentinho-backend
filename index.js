// index.js

// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

// Log para depuração da variável de ambiente do banco de dados
console.log(`DATABASE_URL status: ${process.env.DATABASE_URL ? 'Encontrada' : 'NÃO ENCONTRADA'}`);

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
} else {
  console.warn("Chaves VAPID não configuradas. O envio de notificações está desabilitado.");
}

// --- Rotas da API ---

// Rota para fornecer a chave pública VAPID para o frontend
app.get('/api/vapid-public-key', (req, res) => {
  res.status(200).send(VAPID_PUBLIC_KEY);
});

app.get('/api/estabelecimentos', async (req, res) => {
  const userLat = parseFloat(req.query.lat);
  const userLng = parseFloat(req.query.lng);

  console.log(`GET /api/estabelecimentos para lat: ${userLat}, lng: ${userLng}`);

  try {
    const result = await pool.query('SELECT id, nome, tipo, latitude, longitude, details FROM estabelecimentos');
    
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
    console.error('Erro ao buscar estabelecimentos:', err.stack);
    res.status(500).json({ message: 'Erro ao buscar estabelecimentos.' });
  }
});

app.post('/api/subscribe', async (req, res) => {
  const { subscription, estabelecimentoId } = req.body;
  console.log(`POST /api/subscribe para o estabelecimento ${estabelecimentoId} com o endpoint ${subscription.endpoint}`);

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
    console.error('Erro ao salvar inscrição:', err.stack);
    res.status(500).json({ message: 'Erro ao salvar inscrição.' });
  }
});

app.post('/api/notify/:estabelecimentoId', async (req, res) => {
    const { estabelecimentoId } = req.params;
    const { message, title } = req.body || {}; // Garante que req.body não seja nulo

    console.log(`Enviando notificação para inscritos do estabelecimento ${estabelecimentoId}...`);

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

        const notificationPayload = {
            notification: {
                title: title || 'Pão Quentinho!',
                body: message || 'Uma nova fornada acabou de sair! Venha conferir!',
                icon: 'https://gabriel-nt.github.io/pao-quentinho/assets/icons/icon-192x192.png',
                vibrate: [100, 50, 100],
                data: {
                    url: 'https://gabriel-nt.github.io/pao-quentinho/' 
                }
            }
        };

        const promises = subscriptions.map(sub => 
            webpush.sendNotification(sub, JSON.stringify(notificationPayload))
        );

        await Promise.all(promises);
        res.status(200).json({ message: 'Notificações enviadas.' });
    } catch (err) {
        console.error("Erro ao enviar notificações", err);
        res.sendStatus(500);
    }
});

// Função para testar a conexão com o banco de dados com tentativas
const connectWithRetry = async (retries = 5, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      console.log('✅ Conexão com o banco de dados estabelecida com sucesso.');
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
  console.log('⏰ Verificando fornadas agendadas...');

  try {
    const result = await pool.query('SELECT id, nome, details FROM estabelecimentos');
    const estabelecimentos = result.rows;

    // Otimização: Busca todas as mensagens aleatórias de uma vez, fora do loop
    const messagesResult = await pool.query('SELECT message FROM notification_messages');
    const randomMessages = messagesResult.rows;

    // Obtém a hora atual especificamente no fuso horário de São Paulo para evitar erros de UTC no servidor.
    const nowInSaoPaulo = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
    const now = new Date(nowInSaoPaulo);

    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentMinutesSinceMidnight = currentHours * 60 + currentMinutes;

    for (const est of estabelecimentos) {
      const proximaFornada = est.details.proximaFornada;

      // Ignora se não houver horário de fornada
      if (!proximaFornada || proximaFornada === 'N/A') {
        continue;
      }

      const [fornadaHours, fornadaMinutes] = proximaFornada.split(':').map(Number);

      // Calcula os minutos desde a meia-noite para a hora da notificação (1h antes da fornada)
      const notificationMinutesSinceMidnight = (fornadaHours * 60 + fornadaMinutes) - 60;

      // Compara se o minuto atual do dia é o minuto exato para notificar
      if (currentMinutesSinceMidnight === notificationMinutesSinceMidnight) {
        console.log(`🔥 Hora de notificar para a fornada das ${proximaFornada} no estabelecimento ${est.id} (${est.nome})!`);

        // Busca as inscrições para o estabelecimento específico
        const subscriptionsQuery = `
          SELECT s.subscription_data
          FROM subscriptions s
          JOIN establishment_subscriptions es ON s.id = es.subscription_id
          WHERE es.estabelecimento_id = $1;
        `;
        const subscriptionsResult = await pool.query(subscriptionsQuery, [est.id]);
        const subscriptions = subscriptionsResult.rows.map(row => row.subscription_data);

        if (subscriptions.length > 0) {
          // Seleciona uma mensagem aleatória da lista já buscada
          const randomMessage = randomMessages.length > 0
            ? randomMessages[Math.floor(Math.random() * randomMessages.length)].message
            : `Uma nova fornada sairá às ${proximaFornada}. Não perca!`; // Fallback

          const notificationPayload = {
            notification: {
              title: `Está quase na hora em ${est.nome}!`,
              body: randomMessage,
              icon: 'https://gabriel-nt.github.io/pao-quentinho/assets/icons/icon-192x192.png',
            }
          };

          const promises = subscriptions.map(sub => webpush.sendNotification(sub, JSON.stringify(notificationPayload)));
          await Promise.all(promises);
          console.log(`✅ Notificações enviadas para ${subscriptions.length} inscritos do estabelecimento ${est.id}.`);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao verificar fornadas:', err);
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
      console.log(`🚀 Servidor rodando na porta ${PORT}`);

      // Agenda a verificação de fornadas para rodar a cada 5 minutos.
      cron.schedule('*/5 * * * *', checkFornadasAndNotify, { timezone: "America/Sao_Paulo" });
    });
  } catch (err) {
    console.error('🔥 Falha ao iniciar o servidor:', err.message);
    process.exit(1); // Encerra a aplicação se não conseguir conectar ao DB
  }
};

startServer();
