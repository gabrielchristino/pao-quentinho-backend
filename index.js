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

// --- Constantes de Planos ---
 // Limite de reservas por mês para o plano gratuito. O valor padrão é 5, mas pode ser sobrescrito pela variável de ambiente.
const envLimit = parseInt(process.env.FREE_PLAN_RESERVATION_LIMIT, 10);
const FREE_PLAN_RESERVATION_LIMIT = !isNaN(envLimit) ? envLimit : 5;

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

// Middleware para rotas que exigem perfil de lojista
const lojistaRequired = (req, res, next) => {
  // Primeiro, verifica se o usuário está autenticado
  authRequired(req, res, () => {
    // Se autenticado, verifica se o perfil é 'lojista'
    if (req.user && req.user.role === 'lojista') {
      next();
    } else {
      res.status(403).json({ message: 'Acesso negado. Rota exclusiva para lojistas.' });
    }
  });
};

app.post('/api/estabelecimentos', lojistaRequired, async (req, res) => {
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

app.put('/api/estabelecimentos/:id', lojistaRequired, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const { nome, tipo, latitude, longitude, details } = req.body;

  console.log(`➡️  PUT /api/estabelecimentos/${id} para o usuário ${userId}`);

  if (!nome || !tipo || !latitude || !longitude || !details) {
    return res.status(400).json({ message: 'Dados incompletos para a atualização.' });
  }

  try {
    const updateQuery = `
      UPDATE estabelecimentos
      SET nome = $1, tipo = $2, latitude = $3, longitude = $4, details = $5
      WHERE id = $6 AND user_id = $7
      RETURNING *;
    `;
    const result = await pool.query(updateQuery, [nome, tipo, latitude, longitude, details, id, userId]);

    if (result.rowCount === 0) {
      // Isso pode significar que o estabelecimento não existe ou não pertence ao usuário.
      // Por segurança, retornamos 404 em ambos os casos para não vazar informações.
      return res.status(404).json({ message: 'Estabelecimento não encontrado ou você não tem permissão para editá-lo.' });
    }

    const updatedEstabelecimento = result.rows[0];

    // Remonta o objeto para a resposta
    const responseEstabelecimento = {
      id: updatedEstabelecimento.id,
      nome: updatedEstabelecimento.nome,
      tipo: updatedEstabelecimento.tipo,
      latitude: updatedEstabelecimento.latitude,
      longitude: updatedEstabelecimento.longitude,
      ...updatedEstabelecimento.details
    };

    console.log(`✅ Estabelecimento ID ${id} atualizado com sucesso.`);
    res.status(200).json(responseEstabelecimento);
  } catch (err) {
    console.error(`❌ Erro ao atualizar o estabelecimento ${id}:`, err.stack);
    res.status(500).json({ message: 'Erro ao atualizar o estabelecimento.' });
  }
});

app.delete('/api/estabelecimentos/:id', lojistaRequired, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  console.log(`➡️  DELETE /api/estabelecimentos/${id} pelo usuário ${userId}`);

  try {
    const result = await pool.query('DELETE FROM estabelecimentos WHERE id = $1 AND user_id = $2', [id, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Estabelecimento não encontrado ou você não tem permissão para excluí-lo.' });
    }

    console.log(`✅ Estabelecimento ID ${id} excluído com sucesso.`);
    res.status(204).send(); // 204 No Content é a resposta padrão para exclusões bem-sucedidas.
  } catch (err) {
    console.error(`❌ Erro ao excluir o estabelecimento ${id}:`, err.stack);
    res.status(500).json({ message: 'Erro ao excluir o estabelecimento.' });
  }
});

// Rota para listar as reservas de um estabelecimento (Lojista)
app.get('/api/estabelecimentos/:id/reservas', lojistaRequired, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  console.log(`➡️  GET /api/estabelecimentos/${id}/reservas - Solicitado pelo lojista ${userId}`);

  try {
    // Verifica se o estabelecimento pertence ao lojista
    const verifyOwner = await pool.query('SELECT id FROM estabelecimentos WHERE id = $1 AND user_id = $2', [id, userId]);
    if (verifyOwner.rowCount === 0) {
      return res.status(403).json({ message: 'Você não tem permissão para ver as reservas deste estabelecimento.' });
    }

    const query = `
      SELECT r.id, r.created_at, r.reservation_time, u.name as user_name, u.email as user_email
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      WHERE r.establishment_id = $1
      ORDER BY r.created_at DESC
    `;
    const result = await pool.query(query, [id]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(`❌ Erro ao buscar reservas do estabelecimento ${id}:`, err.stack);
    res.status(500).json({ message: 'Erro ao buscar reservas.' });
  }
});

// --- ROTAS DE USUÁRIO LOGADO ---

// Rota para buscar os estabelecimentos de um usuário logado
app.get('/api/users/me/estabelecimentos', lojistaRequired, async (req, res) => {
  const userId = req.user.userId;
  console.log(`➡️  GET /api/users/me/estabelecimentos para o usuário ${userId}`);

  try {
    const query = `
      SELECT 
        e.id, e.nome, e.tipo, e.latitude, e.longitude, e.details,
        COUNT(es.subscription_id) AS followers_count
      FROM 
        estabelecimentos e
      LEFT JOIN 
        establishment_subscriptions es ON e.id = es.estabelecimento_id
      WHERE e.user_id = $1
      GROUP BY e.id
      ORDER BY e.id DESC;
    `;
    const result = await pool.query(query, [userId]);

    // Remonta o objeto completo que o frontend espera
    const estabelecimentos = result.rows.map(row => ({
      ...row,
      followers_count: parseInt(row.followers_count, 10), // Garante que seja um número
      ...row.details
    }));

    res.status(200).json(estabelecimentos);
  } catch (err) {
    console.error(`❌ Erro ao buscar estabelecimentos do usuário ${userId}:`, err.stack);
    res.status(500).json({ message: 'Erro ao buscar seus estabelecimentos.' });
  }
});

// Rota para buscar os estabelecimentos que um usuário (cliente) segue
app.get('/api/users/me/inscricoes', authRequired, async (req, res) => {
  const userId = req.user.userId;
  console.log(`➡️  GET /api/users/me/inscricoes para o usuário ${userId}`);

  try {
    const query = `
      SELECT DISTINCT
        e.id, e.nome, e.tipo, e.latitude, e.longitude, e.details
      FROM
        estabelecimentos e
      JOIN
        establishment_subscriptions es ON e.id = es.estabelecimento_id
      JOIN
        subscriptions s ON es.subscription_id = s.id
      WHERE
        s.user_id = $1
      ORDER BY
        e.nome;
    `;
    const result = await pool.query(query, [userId]);

    const estabelecimentos = result.rows.map(row => ({
      ...row,
      ...row.details
    }));
    res.status(200).json(estabelecimentos);
  } catch (err) {
    console.error(`❌ Erro ao buscar inscrições do usuário ${userId}:`, err.stack);
    res.status(500).json({ message: 'Erro ao buscar suas inscrições.' });
  }
});

// --- ROTAS DE PLANOS ---

// Rota para listar os planos disponíveis
app.get('/api/plans', authRequired, async (req, res) => {
  console.log('➡️  GET /api/plans - Listando planos');
  try {
    const result = await pool.query('SELECT id, name, description, benefits, price FROM plans WHERE is_active = true ORDER BY price');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar planos:', err.stack);
    res.status(500).json({ message: 'Erro ao buscar os planos.' });
  }
});

// Rota para um usuário atualizar seu plano
app.put('/api/users/me/plan', authRequired, async (req, res) => {
  const userId = req.user.userId;
  const { planId } = req.body;

  console.log(`➡️  PUT /api/users/me/plan - Usuário ${userId} selecionou o plano ${planId}`);

  if (typeof planId !== 'number') {
    return res.status(400).json({ message: 'O ID do plano é obrigatório.' });
  }

  try {
    await pool.query('UPDATE users SET current_plan = $1 WHERE id = $2', [planId, userId]);
    res.status(200).json({ message: 'Plano atualizado com sucesso!' });
  } catch (err) {
    console.error(`❌ Erro ao atualizar plano para o usuário ${userId}:`, err.stack);
    res.status(500).json({ message: 'Erro ao atualizar o plano.' });
  }
});
// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/auth/register', async (req, res) => {
  let { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Nome, email e senha são obrigatórios.' });
  }

  // Validação e valor padrão para a role
  if (role !== 'lojista') {
    role = 'cliente';
  }

  try {
    // Criptografa a senha
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email, name, password_hash, role]
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
    const query = `
      SELECT 
        u.id, u.email, u.name, u.role, u.password_hash,
        p.id as plan_id, p.name as plan_name, p.description as plan_description
      FROM 
        users u
      LEFT JOIN 
        plans p ON u.current_plan = p.id
      WHERE u.email = $1`;
    const result = await pool.query(query, [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Credenciais inválidas.' }); // Usuário não encontrado
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ message: 'Credenciais inválidas.' }); // Senha incorreta
    }

    // Monta o objeto do plano para o JWT
    const plan = user.plan_id ? {
      id: user.plan_id,
      name: user.plan_name,
      description: user.plan_description
    } : null;

    // Gera o token JWT
    const tokenPayload = {
      userId: user.id, email: user.email, name: user.name, role: user.role,
      plan: plan
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token });

  } catch (err) {
    console.error('❌ Erro no login:', err.stack);
    res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

// Rota para obter um novo token com dados atualizados
app.get('/api/auth/refresh', authRequired, async (req, res) => {
  const userId = req.user.userId;
  console.log(`➡️  GET /api/auth/refresh para o usuário ${userId}`);

  try {
    // Busca os dados mais recentes do usuário e do seu plano no banco
    const query = `
      SELECT 
        u.id, u.email, u.name, u.role,
        p.id as plan_id, p.name as plan_name, p.description as plan_description, p.benefits as plan_benefits, p.price as plan_price
      FROM 
        users u
      LEFT JOIN 
        plans p ON u.current_plan = p.id
      WHERE u.id = $1`;
    const result = await pool.query(query, [userId]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }

    // Monta o objeto do plano para o novo JWT
    const plan = user.plan_id ? {
      id: user.plan_id,
      name: user.plan_name,
      description: user.plan_description,
      benefits: user.plan_benefits,
      price: user.plan_price
    } : null;

    // Gera um novo token com as informações atualizadas
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name, role: user.role, plan: plan }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token });

  } catch (err) {
    console.error(`❌ Erro ao atualizar token para o usuário ${userId}:`, err.stack);
    res.status(500).json({ message: 'Erro interno ao atualizar o token.' });
  }
});

// --- ROTA DE SINCRONIZAÇÃO ---

app.post('/api/auth/sync', authRequired, async (req, res) => {
  const userId = req.user.userId;
  const { anonymousEndpoints } = req.body;

  console.log(`➡️  POST /api/auth/sync para o usuário ${userId}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Associa inscrições anônimas (feitas antes do login) a este usuário.
    if (anonymousEndpoints && anonymousEndpoints.length > 0) {
      console.log(`[SYNC] Associando ${anonymousEndpoints.length} inscrições anônimas ao usuário ${userId}...`);
      const updateQuery = `
        UPDATE subscriptions SET user_id = $1 
        WHERE (subscription_data->>'endpoint') = ANY($2::text[]) AND user_id IS NULL
      `;
      await client.query(updateQuery, [userId, anonymousEndpoints]);
    }

    // 2. Busca todos os IDs de estabelecimentos que este usuário já segue em qualquer dispositivo.
    const getSubscriptionsQuery = `
      SELECT DISTINCT es.estabelecimento_id
      FROM establishment_subscriptions es
      JOIN subscriptions s ON es.subscription_id = s.id
      WHERE s.user_id = $1;
    `;
    const result = await client.query(getSubscriptionsQuery, [userId]);
    const syncedEstablishmentIds = result.rows.map(row => row.estabelecimento_id);

    await client.query('COMMIT');

    console.log(`✅ [SYNC] Sincronização concluída. Usuário ${userId} segue ${syncedEstablishmentIds.length} estabelecimentos.`);
    res.status(200).json({ syncedEstablishmentIds });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro durante a sincronização:', err.stack);
    res.status(500).json({ message: 'Erro ao sincronizar inscrições.' });
  } finally {
    client.release();
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
      ON CONFLICT ((subscription_data->>'endpoint')) DO UPDATE 
      SET 
        subscription_data = EXCLUDED.subscription_data,
        -- Se a inscrição existente não tinha dono (era anônima), atribui o novo user_id.
        user_id = COALESCE(subscriptions.user_id, EXCLUDED.user_id)
      RETURNING id;
    `;
    const subResult = await pool.query(upsertSubscriptionQuery, [subscription, userId]);
    const subscriptionId = subResult.rows[0].id;

    // 2. Cria a ligação entre a inscrição e o estabelecimento, SE NÃO FOR UMA INSCRIÇÃO DE LOJISTA.
    // O ID -1 é um sinalizador vindo do frontend para indicar que é apenas o registro do dispositivo do lojista.
    if (estabelecimentoId !== -1) {
      const linkQuery = `
        INSERT INTO establishment_subscriptions (subscription_id, estabelecimento_id) VALUES ($1, $2)
        ON CONFLICT (subscription_id, estabelecimento_id) DO NOTHING;
      `;
      await pool.query(linkQuery, [subscriptionId, estabelecimentoId]);
    }

    // --- LÓGICA PARA NOTIFICAR O LOJISTA VIA PUSH NOTIFICATION ---
    try {
      // 3. Encontra o dono (lojista) do estabelecimento.
      const ownerResult = await pool.query(
        'SELECT user_id, nome FROM estabelecimentos WHERE id = $1',
        [estabelecimentoId]
      );

      if (ownerResult.rowCount > 0 && ownerResult.rows[0].user_id) {
        const ownerId = ownerResult.rows[0].user_id;
        const establishmentName = ownerResult.rows[0].nome;
        console.log(`[NOTIFY-LOJISTA] Novo seguidor para "${establishmentName}". Dono (ID: ${ownerId}) identificado. Buscando suas inscrições...`);

        // 4. Busca todas as inscrições de notificação associadas ao ID do lojista.
        const ownerSubscriptionsResult = await pool.query(
          'SELECT subscription_data FROM subscriptions WHERE user_id = $1',
          [ownerId]
        );

        const ownerSubscriptions = ownerSubscriptionsResult.rows.map(row => row.subscription_data);

        if (ownerSubscriptions.length > 0) {
          console.log(`[NOTIFY-LOJISTA] Encontradas ${ownerSubscriptions.length} inscrições para o lojista. Enviando notificações...`);
          const baseUrl = process.env.APP_BASE_URL || '';
          const notificationPayload = JSON.stringify({
            notification: {
              title: 'Novo Seguidor!',
              body: `Parabéns! ${establishmentName} tem um novo seguidor.`,
              icon: 'assets/icons/icon-192x192.png',
              data: {
                onActionClick: {
                  default: { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}/meus-estabelecimentos` }
                }
              }
            }
          });

          // Envia a notificação para cada dispositivo do lojista.
          const promises = ownerSubscriptions.map(sub => webpush.sendNotification(sub, notificationPayload));
          await Promise.allSettled(promises);
        } else {
          console.log(`[NOTIFY-LOJISTA] O lojista (ID: ${ownerId}) não possui inscrições de notificação ativas.`);
        }
      }
    } catch (notifyErr) {
      // Se a notificação para o lojista falhar, não impede o sucesso da inscrição do usuário.
      console.error('⚠️ Erro ao tentar notificar o lojista sobre novo seguidor:', notifyErr.stack);
    }

    res.status(201).json({ message: 'Inscrição realizada com sucesso.' });
  } catch (err) {
    console.error('❌ Erro ao salvar inscrição:', err.stack);
    res.status(500).json({ message: 'Erro ao salvar inscrição.' });
  }
});

app.delete('/api/unsubscribe', async (req, res) => {
  const { endpoint, estabelecimentoId } = req.query;

  console.log(`➡️  DELETE /api/unsubscribe para o estabelecimento ${estabelecimentoId} no dispositivo ${endpoint}`);

  if (!endpoint || !estabelecimentoId) {
    return res.status(400).json({ message: 'Endpoint e ID do estabelecimento são obrigatórios.' });
  }

  try {
    // 1. Encontra o ID da inscrição com base no endpoint.
    const subIdResult = await pool.query(
      "SELECT id FROM subscriptions WHERE subscription_data->>'endpoint' = $1 LIMIT 1",
      [endpoint]
    );

    console.log(`[UNSUB] Busca pelo endpoint resultou em ${subIdResult.rowCount} linha(s).`);

    if (subIdResult.rowCount === 0 || !subIdResult.rows[0]) {
      console.warn(`[UNSUB] Inscrição com endpoint ${endpoint} não encontrada no banco.`);
      return res.status(404).json({ message: 'Inscrição não encontrada para este dispositivo.' });
    }
    const subscriptionId = subIdResult.rows[0].id;
    console.log(`[UNSUB] ID da inscrição encontrado: ${subscriptionId}.`);

    // 2. Remove a associação entre a inscrição e o estabelecimento.
    const deleteResult = await pool.query(
      'DELETE FROM establishment_subscriptions WHERE subscription_id = $1 AND estabelecimento_id = $2',
      [subscriptionId, estabelecimentoId]
    );
    console.log(`[UNSUB] Operação de DELETE afetou ${deleteResult.rowCount} linha(s).`);

    res.status(200).json({ message: 'Inscrição cancelada com sucesso.' });
  } catch (err) {
    // Este log agora deve capturar qualquer erro inesperado durante o processo.
    console.error('❌ Erro ao cancelar inscrição:', err.stack);
    res.status(500).json({ message: 'Erro ao cancelar inscrição.' });
  }
});

app.post('/api/reserve', authRequired, async (req, res) => {
  const { establishmentId, reservationTime, fornadaId } = req.body; // Aceita fornadaId também
  const userId = req.user.userId; // O ID do usuário vem do token (middleware authRequired)
  const userName = req.user.name; // O nome do usuário vem do token (middleware authRequired)

  if (!establishmentId) {
    return res.status(400).json({ message: 'ID do estabelecimento é obrigatório.' });
  }

  console.log(`➡️  POST /api/reserve - Usuário ${userName} solicitou reserva para o estabelecimento ${establishmentId}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Busca o usuário e bloqueia a linha para evitar race conditions
    const userResult = await client.query('SELECT current_plan, reserve_count FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = userResult.rows[0];

    // 2. Verifica se o usuário está no plano gratuito (0) e se atingiu o limite
    if (user.current_plan === 0 && FREE_PLAN_RESERVATION_LIMIT > 0 && user.reserve_count >= FREE_PLAN_RESERVATION_LIMIT) {
      console.log(`[RESERVE] Bloqueado: Usuário ${userId} (${userName}) atingiu o limite de ${FREE_PLAN_RESERVATION_LIMIT} reservas do plano gratuito.`);
      await client.query('ROLLBACK');
      return res.status(403).json({
        title: 'Limite de Reservas Atingido',
        message: 'Que bom que você está aproveitando! 🧡 Você atingiu o limite de reservas deste mês no plano gratuito. Que tal dar uma olhada nos nossos planos para reservar pão quentinho sempre que quiser?',
        limitReached: true
      });
    }

    // 3. Se o limite não foi atingido, incrementa o contador de reservas.
    await client.query(
      'UPDATE users SET reserve_count = reserve_count + 1 WHERE id = $1',
      [userId]
    );
    console.log(`[RESERVE] Contador de reservas incrementado para o usuário ${userId} - ${userName}.`);

    let finalReservationTime = reservationTime;

    // Se veio um ID de fornada, buscamos o horário e a descrição no cadastro do estabelecimento
    if (fornadaId) {
      const estResult = await client.query('SELECT details FROM estabelecimentos WHERE id = $1', [establishmentId]);
      if (estResult.rowCount > 0) {
        const fornadas = estResult.rows[0].details.proximaFornada || [];
        // Encontra a fornada pelo ID (suporta estrutura nova de objetos)
        const found = fornadas.find(f => f.id === fornadaId);
        if (found) {
          finalReservationTime = found.time;
          console.log(`[RESERVE] Fornada ID ${fornadaId} resolvida para o horário ${finalReservationTime}.`);
        }
      }
    }

    // 4. Salva a reserva na tabela de histórico
    await client.query('INSERT INTO reservations (establishment_id, user_id, reservation_time) VALUES ($1, $2, $3)', [establishmentId, userId, finalReservationTime]);
    console.log(`[RESERVE] Reserva registrada na tabela 'reservations' para o horário: ${finalReservationTime || 'N/A'}.`);

    // 5. Encontra o dono (lojista) e o nome do estabelecimento para notificação.
    const ownerResult = await pool.query(
      'SELECT user_id, nome FROM estabelecimentos WHERE id = $1',
      [establishmentId]
    );

    if (ownerResult.rowCount === 0 || !ownerResult.rows[0].user_id) {
      console.warn(`[RESERVE] Lojista para o estabelecimento ${establishmentId} não encontrado. A reserva foi contada, mas a notificação não será enviada.`);
      // Mesmo sem lojista, a reserva do usuário foi contabilizada, então commitamos e retornamos sucesso.
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Solicitação processada.' });
    }

    const ownerId = ownerResult.rows[0].user_id;
    const establishmentName = ownerResult.rows[0].nome;

    // 6. Busca todas as inscrições de notificação associadas ao ID do lojista.
    const ownerSubscriptionsResult = await pool.query(
      'SELECT subscription_data FROM subscriptions WHERE user_id = $1',
      [ownerId]
    );

    const ownerSubscriptions = ownerSubscriptionsResult.rows.map(row => row.subscription_data);

    if (ownerSubscriptions.length > 0) {
      console.log(`[RESERVE] Enviando notificação de reserva para ${ownerSubscriptions.length} dispositivo(s) do lojista.`);
      const baseUrl = process.env.APP_BASE_URL || '';
      const notificationPayload = JSON.stringify({
        notification: {
          title: 'Solicitação de Reserva!',
          body: `O cliente ${userName} deseja reservar parte da fornada ${finalReservationTime ? 'das ' + finalReservationTime + ' ' : ''}em ${establishmentName}!`,
          icon: 'assets/icons/icon-192x192.png',
          data: {
            onActionClick: {
              default: { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}/estabelecimento/${establishmentId}/reservas` }
            }
          }
        }
      });

      const promises = ownerSubscriptions.map(sub => webpush.sendNotification(sub, notificationPayload));
      await Promise.allSettled(promises);
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Notificação de reserva enviada ao lojista.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao processar solicitação de reserva:', err.stack);
    res.status(500).json({ message: 'Erro ao processar a reserva.' });
  } finally {
    client.release();
  }
});

app.post('/api/notify/:estabelecimentoId', async (req, res) => {
    const { estabelecimentoId } = req.params;
    const { message, title } = req.body || {}; // Garante que req.body não seja nulo

    console.log(`➡️  POST /api/notify/${estabelecimentoId} - Disparando notificação manual...`);

    let establishmentName = null; // Fallback padrão

    // Busca o nome do estabelecimento no banco de dados
    try {
        const establishmentResult = await pool.query('SELECT nome FROM estabelecimentos WHERE id = $1', [estabelecimentoId]);
        if (establishmentResult.rowCount > 0) {
            establishmentName = establishmentResult.rows[0].nome;
        }
    } catch (err) {
        console.error(`❌ Erro ao buscar nome do estabelecimento ${estabelecimentoId}:`, err.stack);
    }
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

        // Pega o horário atual formatado para notificações manuais
        const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        const encodedTime = encodeURIComponent(nowTime);
        const baseUrl = process.env.APP_BASE_URL || '';

        console.log(`[NOTIFY] URL de reserva manual gerada: /reservar/${estabelecimentoId}/horario/${encodedTime}`);

        const notificationPayload = {
            notification: {
                title: title || `Fornada Quentinha${establishmentName ? ' em ' + establishmentName : ''}!`,
                body: notificationBody || 'Uma nova fornada acabou de sair! Venha conferir!', // Fallback final
                icon: 'assets/icons/icon-192x192.png',
                // Adiciona os mesmos botões de ação das notificações automáticas
                actions: [
                  { action: 'reserve', title: '🥖 Reservar' },
                  { action: 'dismiss', title: '👍 Agora não' }
                ],
                // A propriedade 'data' é crucial para o Service Worker do Angular (ngsw)
                // saber como agir quando a notificação é clicada com o app fechado.
                data: {
                  onActionClick: {
                    // Ação padrão (clicar no corpo da notificação) abre o card do estabelecimento.
                    default: { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}/estabelecimento/${estabelecimentoId}` },
                    // Ação para o botão 'reserve' abre a página de confirmação da reserva.
                    'reserve': { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}/reservar/${estabelecimentoId}/horario/${encodedTime}` }
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
      for (const fornadaItem of fornadas) {
        let fornadaTime, fornadaId, fornadaDescription;

        // Suporte híbrido: string antiga ou objeto novo { id, time, description }
        if (typeof fornadaItem === 'string') {
          fornadaTime = fornadaItem;
        } else {
          fornadaTime = fornadaItem.time;
          fornadaId = fornadaItem.id;
          fornadaDescription = fornadaItem.description;
        }

        if (fornadaTime) {
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
                : `Uma nova fornada ${fornadaDescription ? 'de ' + fornadaDescription + ' ' : ''}sairá às ${fornadaTime}. Não perca!`;

              console.log(`[CRON] Mensagem selecionada para notificação: "${randomMessage}"`);

              // Define a URL de reserva baseada no tipo de dado disponível (ID ou Horário)
              const baseUrl = process.env.APP_BASE_URL || '';
              const encodedTime = encodeURIComponent(fornadaTime);
              const reserveUrl = fornadaId 
                ? `/reservar/${est.id}/fornada/${fornadaId}` 
                : `/reservar/${est.id}/horario/${encodedTime}`;

              console.log(`[CRON] URL de reserva agendada gerada: ${reserveUrl}`);

              const notificationPayload = {
                notification: {
                  title: isAlmostTime ? `Está saindo agora em ${est.nome}!` : `Falta 1h para a fornada em ${est.nome}!`,
                  body: randomMessage,
                  icon: 'assets/icons/icon-192x192.png',
                  // Define os botões que aparecerão na notificação
                  actions: [
                    { action: 'reserve', title: '🥖 Reservar' },
                    { action: 'dismiss', title: '👍 Agora não' }
                  ],
                  // A propriedade 'data' é crucial para o Service Worker do Angular (ngsw)
                  data: {
                    onActionClick: {
                      // Ação padrão (clicar no corpo da notificação) abre o card do estabelecimento.
                      default: { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}/estabelecimento/${est.id}` },
                      // Ação para o botão 'reserve' abre a página de confirmação da reserva.
                      'reserve': { operation: 'navigateLastFocusedOrOpen', url: `${baseUrl}${reserveUrl}` }
                      // O botão 'dismiss' não precisa de ação aqui, pois o Service Worker o ignora por padrão.
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
 * Zera o contador de reservas de todos os usuários.
 * Agendado para rodar à meia-noite do primeiro dia de cada mês.
 */
const resetReserveCounts = async () => {
  console.log('🗓️  [CRON] Iniciando rotina mensal para zerar contagem de reservas...');
  try {
    const result = await pool.query('UPDATE users SET reserve_count = 0');
    console.log(`✅ [CRON] Contagem de reservas zerada. ${result.rowCount} usuários foram atualizados.`);
  } catch (err) {
    console.error('❌ [CRON] Erro ao zerar a contagem de reservas:', err.stack);
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

      // Agenda a rotina para zerar a contagem de reservas todo dia 1º do mês à meia-noite.
      cron.schedule('0 0 1 * *', resetReserveCounts, { timezone: "America/Sao_Paulo" });
    });
  } catch (err) {
    console.error('🔥 Falha ao iniciar o servidor:', err.message);
    process.exit(1); // Encerra a aplicação se não conseguir conectar ao DB
  }
};

startServer();
