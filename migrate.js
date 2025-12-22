// migrate.js
// Script seguro para criar as tabelas necessárias sem apagar dados.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Iniciando migração (CREATE TABLE IF NOT EXISTS)...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'cliente',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        reserve_count INTEGER NOT NULL DEFAULT 0,
        current_plan INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Adiciona a coluna reserve_count se ela não existir, para não quebrar migrações futuras
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'reserve_count') THEN
          ALTER TABLE users ADD COLUMN reserve_count INTEGER NOT NULL DEFAULT 0;
        END IF;
      END$$;
    `);

    // Adiciona a coluna current_plan se ela não existir
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'current_plan') THEN
          ALTER TABLE users ADD COLUMN current_plan INTEGER NOT NULL DEFAULT 0;
        END IF;
      END$$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS estabelecimentos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(100),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        details JSONB,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        subscription_data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Índice único para endpoint (cria somente se não existir)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'i' AND c.relname = 'subscriptions_endpoint_unique_idx'
        ) THEN
          CREATE UNIQUE INDEX subscriptions_endpoint_unique_idx ON subscriptions ((subscription_data->>'endpoint'));
        END IF;
      END$$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS establishment_subscriptions (
        subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        estabelecimento_id INTEGER NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
        PRIMARY KEY (subscription_id, estabelecimento_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_messages (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY, -- Usamos INTEGER e não SERIAL para controlar os IDs
        name VARCHAR(255) NOT NULL,
        description TEXT,
        benefits TEXT[] NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        establishment_id INTEGER REFERENCES estabelecimentos(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reservation_time VARCHAR(10),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Adiciona a coluna reservation_time se ela não existir (para tabelas já criadas)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'reservations'::regclass AND attname = 'reservation_time') THEN
          ALTER TABLE reservations ADD COLUMN reservation_time VARCHAR(10);
        END IF;
      END$$;
    `);

    console.log('Tabela "plans" verificada/criada. Inserindo plano padrão se necessário...');

    await client.query(
      `INSERT INTO plans (id, name, description, benefits, price, is_active)
       SELECT 1, 'Pão Quentinho Pro', 'Reservas ilimitadas e muito mais para você nunca perder uma fornada.', ARRAY['Número ilimitado de reservas por mês'], 4.99, true
       WHERE NOT EXISTS (SELECT 1 FROM plans WHERE id = 1)`
    );

    console.log('Tabelas criadas/verificadas com sucesso. Inserindo mensagens padrão se necessário...');

    const defaultMessages = [
      'Acabou de sair uma nova fornada! Venha conferir!',
      'Pão quentinho esperando por você! 🥖',
      'Sentiu o cheirinho? Fornada nova na área!',
      'Não perca! Produtos fresquinhos acabaram de sair do forno.',
      "Ei, saiu uma fornada! Corra antes que esfrie 🥐🔥",
      "Pão quentinho esperando por você! 🥖😊",
      "Sentiu o cheirinho? Fornada nova na área! 😋",
      "Não perca! Produtos fresquinhos acabaram de sair do forno. ✨",
      "Fornada saindo agora — vem buscar o seu! 🚶‍♀️🥯",
      "Pausa para o cheirinho: nova fornada disponível 👃💛",
      "O padeiro mandou avisar: saiu mais pão! 👨‍🍳🔥",
      "Tem pãozinho quentinho na vitrine — corre antes que acabe 😍",
      "Hora do lanche: fornada saindo neste momento 🍩😋",
      "Acerte o passo: pão quente te espera na loja! 🚗💨",
      "Traga fome — temos pão quentinho saindo do forno 😄🍞",
      "Sabor recém-saído do forno — experimente hoje mesmo 👅🔥",
      "Pães fresquinhos chegaram 🥖🌿",
      "Atenção, amante de pão: novidade quentinha disponível! ❤️🥐",
      "Pequena felicidade do dia: fornada pronta 🙌🍞",
      "Aviso amigo: pão quentinho na área — passa aqui! 🫶",
      "Leveza no paladar: novos pães acabaram de sair do forno ☁️🥐",
      "Não esquece: temos seu pão preferido quentinho agora 🔔🥖",
      "Sorriso + pão quente = dia feliz. Venha conferir! 😁🥯"
    ];

    for (const msg of defaultMessages) {
      await client.query(
        `INSERT INTO notification_messages (message)
         SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM notification_messages WHERE message = $1)`,
        [msg]
      );
    }

    console.log('Migração concluída com sucesso.');
  } catch (err) {
    console.error('Erro durante migração:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
