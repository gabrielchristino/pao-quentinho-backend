// Carrega as variáveis de ambiente do arquivo .env para o process.env
require('dotenv').config();

const { Pool } = require('pg');

// Dados iniciais dos estabelecimentos
const estabelecimentosData = [
  {
    id: 1,
    nome: 'Sacolão Campo Grande',
    tipo: 'outros',
    horarioAbertura: '07:00',
    horarioFechamento: '21:00',
    proximaFornada: '16:00',
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
    proximaFornada: '16:00',
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
    proximaFornada: '16:00',
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
    proximaFornada: 'N/A',
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
    proximaFornada: 'N/A',
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
    proximaFornada: 'N/A',
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
    proximaFornada: 'N/A',
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
    proximaFornada: 'N/A',
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

    // Limpa a tabela antes de inserir novos dados para evitar duplicatas
    console.log('Limpando a tabela "estabelecimentos"...');
    await client.query('TRUNCATE TABLE estabelecimentos RESTART IDENTITY CASCADE');

    // Insere cada estabelecimento no banco de dados
    console.log('Inserindo novos dados...');
    for (const est of estabelecimentosData) {
      // Separa os campos principais dos detalhes para inserção nas colunas corretas
      const { id, nome, tipo, latitude, longitude, ...details } = est;
      
      const insertQuery = `
        INSERT INTO estabelecimentos (id, nome, tipo, latitude, longitude, details)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await client.query(insertQuery, [id, nome, tipo, latitude, longitude, details]);
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