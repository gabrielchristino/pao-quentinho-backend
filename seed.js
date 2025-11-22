// Carrega as variáveis de ambiente do arquivo .env para o process.env
require('dotenv').config();

/**
 * Gera horários de fornada dinâmicos para facilitar os testes.
 * A cada 5 minutos, um novo estabelecimento irá disparar uma notificação.
 * @returns {string[]} Um array com um único horário de fornada.
 */
function generateTestTime(offsetMinutes = 0) {
  const now = new Date();
  // Adiciona o deslocamento e mais 5 minutos (por causa da lógica de notificar 5 min antes)
  now.setMinutes(now.getMinutes() + offsetMinutes + 5);

  // Arredonda para o próximo múltiplo de 5 minutos para sincronizar com o cron
  const minutes = now.getMinutes();
  const roundedMinutes = Math.ceil(minutes / 5) * 5;
  now.setMinutes(roundedMinutes);

  const hours = String(now.getHours()).padStart(2, '0');
  const finalMinutes = String(now.getMinutes()).padStart(2, '0');
  return [`${hours}:${finalMinutes}`];
}

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Dados iniciais dos estabelecimentos
const estabelecimentosData = [
  {
    id: 1,
    nome: 'Sacolão Campo Grande',
    tipo: 'outros',
    horarioAbertura: '07:00',
    horarioFechamento: '21:05',
    proximaFornada: generateTestTime(0), // Notificará no próximo ciclo de 5 min
    endereco: { rua: 'Av. Nossa Sra. do Sabará', numero: '2001', bairro: 'Vila Santana', cidade: 'São Paulo', estado: 'SP', cep: '04685-004', complemento: '' },
    info: 'Mercado de frutas, vegetais e produtos frescos. Pães e salgados disponíveis na padaria interna.',
    latitude: -23.672309973956033,
    longitude: -46.68705772329827
  },
  {
    id: 2,
    nome: 'OXXO - Sines',
    tipo: 'mercado',
    horarioAbertura: '00:00',
    horarioFechamento: '23:59', // Representando 24 horas
    proximaFornada: generateTestTime(5), // Notificará 5 minutos depois do anterior
    endereco: { rua: 'Av. Nossa Sra. do Sabará', numero: '1785', bairro: 'Vila Sofia', cidade: 'São Paulo', estado: 'SP', cep: '04685-004' },
    info: 'Mercado de conveniência com atendimento 24 horas. Lanches, bebidas e produtos de padaria.',
    latitude: -23.670029653701853,
    longitude: -46.68829784147591
  },
  {
    id: 3,
    nome: 'Nova Barão Lanchonete',
    tipo: 'padaria',
    horarioAbertura: '06:00',
    horarioFechamento: '23:00',
    proximaFornada: generateTestTime(10), // Notificará 10 minutos depois
    endereco: { rua: 'Av. Nossa Sra. do Sabará', numero: '2148', bairro: 'Jardim Campo Grande', cidade: 'São Paulo', estado: 'SP', cep: '04686-002' },
    info: 'Lanchonete e padaria com variedade de salgados, lanches e pães.',
    latitude: -23.673485126217443,
    longitude: -46.68660672925216
  },
  {
    id: 4,
    nome: 'Pão de Açúcar',
    tipo: 'mercado',
    horarioAbertura: '07:00',
    horarioFechamento: '22:00',
    proximaFornada: generateTestTime(15), // Notificará 15 minutos depois
    endereco: { rua: 'R. Moacir Simões da Rocha', numero: '105', bairro: 'Vila Sao Pedro', cidade: 'São Paulo', estado: 'SP', cep: '04674-150' },
    info: 'Supermercado completo com padaria, açougue e uma grande variedade de produtos.',
    latitude: -23.665293867593874,
    longitude: -46.68941222071169
  },
  {
    id: 5,
    nome: 'Panificadora Canaã',
    tipo: 'padaria',
    horarioAbertura: '06:00',
    horarioFechamento: '21:30',
    proximaFornada: generateTestTime(20), // Notificará 20 minutos depois
    endereco: { rua: 'R. Antônio do Campo', numero: '444', bairro: 'Pedreira', cidade: 'São Paulo', estado: 'SP', cep: '04459-000' },
    info: 'Padaria tradicional com pães frescos, bolos e salgados.',
    latitude: -23.692614433202063,
    longitude: -46.672676378654344
  },
  {
    id: 6,
    nome: 'Adega Nossa Senhora Lurdes',
    tipo: 'mercado',
    horarioAbertura: '07:00',
    horarioFechamento: '21:00',
    proximaFornada: [],
    endereco: { rua: 'R. Alzira Alves dos Santos', numero: '177', bairro: 'Pedreira', cidade: 'São Paulo', estado: 'SP', cep: '04459-240' },
    info: 'Adega com variedade de bebidas e produtos.',
    latitude: -23.6937513081122,
    longitude: -46.67198067791495
  },
  {
    id: 7,
    nome: 'Sodiê Doces São Paulo Interlagos',
    tipo: 'casaDeBolos',
    horarioAbertura: '09:00',
    horarioFechamento: '19:00',
    proximaFornada: [],
    endereco: { rua: 'Av. Interlagos', numero: '3327', bairro: 'Interlagos', cidade: 'São Paulo', estado: 'SP', cep: '04661-200' },
    info: 'A maior variedade de bolos do Brasil. Perfeito para sua festa ou sobremesa.',
    latitude: -23.67937586467009,
    longitude: -46.68581554119652
  },
  {
    id: 8,
    nome: 'Padaria Dona Lena',
    tipo: 'padaria',
    horarioAbertura: '06:00',
    horarioFechamento: '22:00',
    proximaFornada: [],
    endereco: { rua: 'Av. Nossa Sra. do Sabará', numero: '3610', bairro: 'Vila Emir', cidade: 'São Paulo', estado: 'SP', cep: '04447-010' },
    info: 'Padaria e confeitaria com pães, bolos, doces e salgados.',
    latitude: -23.68507788734944,
    longitude: -46.680465656009815
  },
];

// Configuração do Pool de Conexão
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function seedDatabase() {
  const client = await pool.connect();
  try {
    console.log('Iniciando o processo de seed...');

    // --- 1. Apaga e Recria as Tabelas ---
    // Usar DROP e CREATE garante um ambiente limpo a cada execução.

    console.log('Apagando tabelas antigas (se existirem)...');
    // A ordem de DROP é a inversa da criação para respeitar as dependências.
    // O CASCADE cuida de remover as dependências automaticamente.
    await client.query(`
      DROP TABLE IF EXISTS establishment_subscriptions;
      DROP TABLE IF EXISTS subscriptions;
      DROP TABLE IF EXISTS estabelecimentos;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS notification_messages;
    `);

    console.log('Criando novas tabelas...');
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'cliente',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE estabelecimentos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(100),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        details JSONB,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Um estabelecimento pode não ter dono
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- Se o usuário for deletado, suas inscrições também são
        subscription_data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Cria um índice único na expressão para garantir que cada endpoint de dispositivo seja único.
    // Isso é feito separadamente porque a sintaxe de índice de expressão não é permitida inline no CREATE TABLE.
    await client.query(`
      CREATE UNIQUE INDEX subscriptions_endpoint_unique_idx ON subscriptions ((subscription_data->>'endpoint'));
    `);




    await client.query(`
      CREATE TABLE establishment_subscriptions (
        subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        estabelecimento_id INTEGER NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
        PRIMARY KEY (subscription_id, estabelecimento_id)
      );
    `);

    await client.query(`
      CREATE TABLE notification_messages (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL
      );
    `);

    // --- 2. Populando as Tabelas ---
    const notificationMessages = [
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

    console.log('Populando a tabela "notification_messages"...');
    for (const msg of notificationMessages) {
      await client.query('INSERT INTO notification_messages (message) VALUES ($1)', [msg]);
    }

    console.log('Criando usuário lojista de teste...');
    const testUserEmail = 'gabriel.christino@gmail.com';
    const testUserPassword = '123456';
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(testUserPassword, salt);

    const userResult = await client.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'lojista') RETURNING id",
      [testUserEmail, 'Usuário Lojista', passwordHash]
    );
    const testUserId = userResult.rows[0].id;
    console.log(`Usuário lojista de teste criado com ID: ${testUserId}. (Email: ${testUserEmail}, Senha: ${testUserPassword})`);

    console.log('Criando usuário cliente de teste...');
    const clienteUserEmail = 'moon.tamires@gmail.com';
    const clienteUserPassword = '123456';
    const clienteSalt = await bcrypt.genSalt(10);
    const clientePasswordHash = await bcrypt.hash(clienteUserPassword, clienteSalt);

    const clienteUserResult = await client.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'cliente') RETURNING id",
      [clienteUserEmail, 'Usuário Cliente', clientePasswordHash]
    );
    console.log(`Usuário cliente de teste criado com ID: ${clienteUserResult.rows[0].id}. (Email: ${clienteUserEmail}, Senha: ${clienteUserPassword})`);


    console.log('Populando a tabela "estabelecimentos"...');
    for (const est of estabelecimentosData) {
      // Separa os campos principais dos detalhes para inserção nas colunas corretas
      const { id, nome, tipo, latitude, longitude, ...details } = est;
      
      const insertQuery = `
        INSERT INTO estabelecimentos (id, nome, tipo, latitude, longitude, details, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      // Associa todos os estabelecimentos de teste ao usuário de teste
      await client.query(insertQuery, [id, nome, tipo, latitude, longitude, details, testUserId]);
    }

    // --- 3. Sincronização da Sequência de IDs ---
    // Busca o maior ID inserido manualmente
    const maxIdResult = await client.query('SELECT MAX(id) FROM estabelecimentos');
    const maxId = maxIdResult.rows[0].max || 0;

    // Atualiza o contador da sequência para o próximo valor disponível
    console.log(`Sincronizando a sequência de IDs para começar após ${maxId}...`);
    await client.query(`SELECT setval(pg_get_serial_sequence('estabelecimentos', 'id'), ${maxId})`);

    console.log('✅ Seed concluído com sucesso!');
  } catch (err) {
    console.error('❌ Erro durante o processo de seed:', err.stack);
  } finally {
    // Libera o cliente de volta para o pool
    client.release();
    // Fecha o pool de conexões
    await pool.end();
  }
}

seedDatabase();