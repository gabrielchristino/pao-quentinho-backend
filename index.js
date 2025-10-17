// index.js

// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

// Log para depuração da variável de ambiente do banco de dados
console.log(`DATABASE_URL status: ${process.env.DATABASE_URL ? 'Encontrada' : 'NÃO ENCONTRADA'}`);

const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg'); // Importa o driver do PostgreSQL

const app = express();

// --- Configuração do Banco de Dados ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Usa a URL fornecida pelo Railway
  ssl: {
    rejectUnauthorized: false // Necessário para conexões SSL em ambientes como Railway/Heroku
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

// Middlewares
app.use(cors());
app.use(bodyParser.json());

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
app.get('/api/estabelecimentos', async (req, res) => {
  const userLat = parseFloat(req.query.lat);
  const userLng = parseFloat(req.query.lng);

  console.log(`GET /api/estabelecimentos para lat: ${userLat}, lng: ${userLng}`);

  try {
    const result = await pool.query('SELECT data FROM estabelecimentos');
    let estabelecimentos = result.rows.map(row => row.data);

    // Se as coordenadas do usuário foram fornecidas, calcula a distância
    if (!isNaN(userLat) && !isNaN(userLng)) {
      estabelecimentos = estabelecimentos.map(est => {
        const distanciaKm = calculateDistance(userLat, userLng, est.latitude, est.longitude);
        return { ...est, distanciaKm };
      });
    }

    res.status(200).json(estabelecimentos.sort((a, b) => a.distanciaKm - b.distanciaKm));
  } catch (err) {
    console.error('Erro ao buscar estabelecimentos:', err.stack);
    res.status(500).json({ message: 'Erro ao buscar estabelecimentos.' });
  }
});

app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  console.log('POST /api/subscribe', subscription.endpoint);
  
  // A cláusula ON CONFLICT impede a inserção de inscrições duplicadas
  const insertQuery = 'INSERT INTO subscriptions(subscription_data) VALUES($1) ON CONFLICT (subscription_data) DO NOTHING';
  
  try {
    await pool.query(insertQuery, [subscription]);
    res.status(201).json({ message: 'Inscrição realizada com sucesso.' });
  } catch (err) {
    console.error('Erro ao salvar inscrição:', err.stack);
    res.status(500).json({ message: 'Erro ao salvar inscrição.' });
  }
});

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
    });
  } catch (err) {
    console.error('🔥 Falha ao iniciar o servidor:', err.message);
    process.exit(1); // Encerra a aplicação se não conseguir conectar ao DB
  }
};

startServer();
