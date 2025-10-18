# Pão Quentinho - Backend

Este é o serviço de backend para a aplicação PWA "Pão Quentinho". Ele é responsável por gerenciar os dados dos estabelecimentos, lidar com as inscrições para notificações push e enviar as notificações (tanto de forma agendada quanto manual).

O backend é construído com Node.js, Express, e se conecta a um banco de dados PostgreSQL.

## Funcionalidades

- **Servir Dados**: Fornece uma lista de estabelecimentos, com a opção de ordená-los por proximidade a um usuário.
- **Inscrição para Notificações**: Salva as inscrições de usuários que desejam receber alertas sobre fornadas.
- **Notificações Agendadas**: Um `cron job` verifica periodicamente os horários das próximas fornadas e envia notificações 1 hora e 5 minutos antes.
- **Notificações Manuais**: Permite o disparo de notificações imediatas para um estabelecimento específico através de uma rota de API.

## Começando

### Pré-requisitos

- Node.js (versão 22.0.0 ou superior)
- PostgreSQL
- Um arquivo `.env` com as variáveis de ambiente configuradas.

### Instalação

1. Clone o repositório.
2. Navegue até a pasta do backend: `cd pao-quentinho-backend`
3. Instale as dependências:
   ```bash
   npm install
   ```

### Configuração do Ambiente

Crie um arquivo `.env` na raiz do projeto e adicione as seguintes variáveis:

```env
# URL de conexão com o seu banco de dados PostgreSQL
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"

# Chaves VAPID para Web Push Notifications (gere um par usando `npx web-push generate-vapid-keys`)
VAPID_PUBLIC_KEY="SUA_CHAVE_PUBLICA_VAPID"
VAPID_PRIVATE_KEY="SUA_CHAVE_PRIVADA_VAPID"
```

### Rodando a Aplicação

- Para desenvolvimento (com recarregamento automático):
  ```bash
  npm run dev
  ```
- Para produção:
  ```bash
  npm start
  ```

O servidor estará rodando em `http://localhost:3000` (ou na porta definida pela variável `PORT`).

---

## API Endpoints

A seguir estão detalhadas as rotas disponíveis na API.

### 1. Obter a Chave Pública VAPID

Fornece a chave pública VAPID necessária para o frontend se inscrever nas notificações push.

- **Método**: `GET`
- **URL**: `/api/vapid-public-key`
- **Exemplo com `curl`**:
  ```bash
  curl https://pao-quentinho-backend-production.up.railway.app/api/vapid-public-key
  ```

### 2. Listar Estabelecimentos

Retorna uma lista de todos os estabelecimentos. Se as coordenadas de geolocalização (`lat`, `lng`) forem fornecidas como query parameters, a lista será ordenada pelo mais próximo.

- **Método**: `GET`
- **URL**: `/api/estabelecimentos`
- **Query Parameters (Opcionais)**:
  - `lat`: Latitude do usuário.
  - `lng`: Longitude do usuário.
- **Exemplo (sem geolocalização)**:
  ```bash
  curl https://pao-quentinho-backend-production.up.railway.app/api/estabelecimentos
  ```
- **Exemplo (com geolocalização)**:
  ```bash
  curl "https://pao-quentinho-backend-production.up.railway.app/api/estabelecimentos?lat=-23.672&lng=-46.687"
  ```

### 3. Inscrever-se para Notificações

Registra um usuário para receber notificações de um estabelecimento específico.

- **Método**: `POST`
- **URL**: `/api/subscribe`
- **Corpo da Requisição (JSON)**:
  ```json
  {
    "subscription": { "...objeto PushSubscription do navegador..." },
    "estabelecimentoId": 1
  }
  ```
- **Exemplo com `curl`**:
  ```bash
  curl -X POST \
    -H "Content-Type: application/json" \
    -d '{"subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }, "estabelecimentoId": 1}' \
    https://pao-quentinho-backend-production.up.railway.app/api/subscribe
  ```

### 4. Enviar Notificação Manual

Dispara uma notificação para todos os usuários inscritos em um determinado estabelecimento. É possível enviar uma mensagem e título personalizados; caso contrário, uma mensagem aleatória do banco de dados será usada.

- **Método**: `POST`
- **URL**: `/api/notify/:estabelecimentoId`
- **Parâmetro da URL**:
  - `estabelecimentoId`: O ID do estabelecimento.
- **Corpo da Requisição (JSON, Opcional)**:
  ```json
  {
    "title": "Título Personalizado",
    "message": "Mensagem personalizada da notificação."
  }
  ```
- **Exemplo (com mensagem personalizada)**:
  ```bash
  curl -X POST \
    -H "Content-Type: application/json" \
    -d '{"title": "Fornada Especial!", "message": "Pão de queijo quentinho saindo agora!"}' \
    https://pao-quentinho-backend-production.up.railway.app/api/notify/5
  ```
- **Exemplo (com mensagem aleatória padrão)**:
  ```bash
  curl -X POST https://pao-quentinho-backend-production.up.railway.app/api/notify/5
  ```