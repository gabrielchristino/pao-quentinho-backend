// index.js
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

// Função para criar as tabelas se elas não existirem
const initializeDatabase = async () => {
  const createTablesQuery = `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      subscription_data JSONB NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS estabelecimentos (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `;
  try {
    await pool.query(createTablesQuery);
    console.log('Tabelas verificadas/criadas com sucesso.');
  } catch (err) {
    console.error('Erro ao criar tabelas:', err.stack);
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
  console.log('GET /api/estabelecimentos');
  try {
    const result = await pool.query('SELECT data FROM estabelecimentos');
    // Extrai o objeto 'data' de cada linha
    const estabelecimentos = result.rows.map(row => row.data);
    res.status(200).json(estabelecimentos);
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

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  // Garante que as tabelas do banco de dados sejam criadas ao iniciar
  initializeDatabase();
});
