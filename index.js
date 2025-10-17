// index.js
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// --- Configuração das Notificações Push ---
// As chaves são lidas das variáveis de ambiente do Railway
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.log("Você precisa configurar as variáveis de ambiente VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.");
} else {
  webpush.setVapidDetails(
    'mailto:seu-email@exemplo.com', // Um email de contato
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// Em um app real, você salvaria isso em um banco de dados!
let subscriptions = [];

// --- Dados dos Estabelecimentos (Mock) ---
const estabelecimentos = [
    { nome: 'Padaria Pão do Bairro', tipo: 'padaria', horarioAbertura: '06:30', horarioFechamento: '20:00', proximaFornada: '16:30', endereco: { rua: 'Rua das Oliveiras', numero: '101', bairro: 'Jardim das Oliveiras', cidade: 'São Paulo', estado: 'SP', cep: '04810-000', complemento: 'Ao lado do mercado' }, info: 'Pão francês quentinho toda hora! Venha experimentar nossos salgados.', distanciaKm: 0.7, latitude: -23.551, longitude: -46.634 },
    { nome: 'Doceria Sabor Real', tipo: 'doceria', horarioAbertura: '08:00', horarioFechamento: '19:00', proximaFornada: '17:00', endereco: { rua: 'Avenida Real', numero: '200', bairro: 'Jardim Real', cidade: 'São Paulo', estado: 'SP', cep: '04811-000' }, info: 'Doces finos e bolos decorados. Experimente nosso bolo de leite ninho!', distanciaKm: 0.9, latitude: -23.552, longitude: -46.635 },
    // Adicione os outros estabelecimentos aqui...
];

// --- Rotas da API ---
app.get('/api/estabelecimentos', (req, res) => {
  console.log('GET /api/estabelecimentos');
  res.status(200).json(estabelecimentos);
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  console.log('POST /api/subscribe', subscription.endpoint);
  subscriptions.push(subscription);
  res.status(201).json({ message: 'Inscrição realizada com sucesso.' });
});

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
