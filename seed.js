// Carrega as variáveis de ambiente do arquivo .env para o process.env
require('dotenv').config();

const { Pool } = require('pg');

// Dados iniciais dos estabelecimentos
const estabelecimentosData = [
  {
    nome: 'Padaria Pão do Bairro',
    tipo: 'padaria',
    horarioAbertura: '06:30',
    horarioFechamento: '20:00',
    proximaFornada: '16:30',
    endereco: { rua: 'Rua das Oliveiras', numero: '101', bairro: 'Jardim das Oliveiras', cidade: 'São Paulo', estado: 'SP', cep: '04810-000', complemento: 'Ao lado do mercado' },
    info: 'Pão francês quentinho toda hora! Venha experimentar nossos salgados.',
    latitude: -23.551,
    longitude: -46.634
  },
  {
    nome: 'Doceria Sabor Real',
    tipo: 'doceria',
    horarioAbertura: '08:00',
    horarioFechamento: '19:00',
    proximaFornada: '17:00',
    endereco: { rua: 'Avenida Real', numero: '200', bairro: 'Jardim Real', cidade: 'São Paulo', estado: 'SP', cep: '04811-000' },
    info: 'Doces finos e bolos decorados. Experimente nosso bolo de leite ninho!',
    latitude: -23.552,
    longitude: -46.635
  },
  {
    nome: 'Confeitaria Delícias da Vila',
    tipo: 'confeitaria',
    horarioAbertura: '07:00',
    horarioFechamento: '18:00',
    proximaFornada: '15:30',
    endereco: { rua: 'Rua da Vila', numero: '55', bairro: 'Vila Nova', cidade: 'São Paulo', estado: 'SP', cep: '04812-000', complemento: 'Próximo ao parque' },
    info: 'Tortas e doces caseiros. Venha provar nossa torta de limão!',
    latitude: -23.553,
    longitude: -46.636
  },
  {
    nome: 'Casa de Bolos Dona Benta',
    tipo: 'casaDeBolos',
    horarioAbertura: '09:00',
    horarioFechamento: '18:30',
    proximaFornada: '14:30',
    endereco: { rua: 'Travessa dos Bolos', numero: '10', bairro: 'Vila Benta', cidade: 'São Paulo', estado: 'SP', cep: '04813-000' },
    info: 'Bolos caseiros e receitas tradicionais. Sinta o sabor da infância!',
    latitude: -23.554,
    longitude: -46.637
  },
  {
    nome: 'Padaria e Confeitaria Nova Era',
    tipo: 'padaria',
    horarioAbertura: '06:00',
    horarioFechamento: '21:00',
    proximaFornada: '18:00',
    endereco: { rua: 'Rua Nova Era', numero: '300', bairro: 'Nova Era', cidade: 'São Paulo', estado: 'SP', cep: '04814-000', complemento: 'Em frente à escola' },
    info: 'Pães, doces e bolos fresquinhos todos os dias. Venha conferir nossas promoções!',
    latitude: -23.555,
    longitude: -46.638
  }
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

    // Limpa a tabela antes de inserir novos dados para evitar duplicatas
    console.log('Limpando a tabela "estabelecimentos"...');
    await client.query('TRUNCATE TABLE estabelecimentos RESTART IDENTITY CASCADE');

    // Insere cada estabelecimento no banco de dados
    console.log('Inserindo novos dados...');
    for (const est of estabelecimentosData) {
      // O PostegreSQL converte automaticamente o objeto JS em JSONB
      await client.query('INSERT INTO estabelecimentos (data) VALUES ($1)', [est]);
    }

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