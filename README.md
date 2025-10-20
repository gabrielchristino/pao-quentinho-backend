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

A API é dividida em seções: rotas públicas, de autenticação e rotas que exigem autenticação.

### Rotas Públicas

Estas rotas podem ser acessadas sem autenticação.

#### 1. Obter Chave Pública VAPID
- **Método**: `GET`
- **URL**: `/api/vapid-public-key`
- **Descrição**: Retorna a chave pública VAPID necessária para o frontend se inscrever nas notificações push.

#### 2. Listar Estabelecimentos
- **Método**: `GET`
- **URL**: `/api/estabelecimentos`
- **Descrição**: Retorna uma lista de todos os estabelecimentos. Se as coordenadas `lat` e `lng` forem fornecidas, a lista é ordenada por proximidade.
- **Query (Opcional)**: `lat`, `lng`

#### 3. Obter Detalhes de um Estabelecimento
- **Método**: `GET`
- **URL**: `/api/estabelecimentos/:id`
- **Descrição**: Retorna os detalhes de um único estabelecimento pelo seu ID.

#### 4. Inscrever-se para Notificações
- **Método**: `POST`
- **URL**: `/api/subscribe`
- **Descrição**: Registra um dispositivo para receber notificações de um estabelecimento. Se um token de autenticação for enviado, a inscrição é associada ao usuário.
- **Corpo (JSON)**:
  ```json
  {
    "subscription": { "...objeto PushSubscription..." },
    "estabelecimentoId": 1
  }
  ```

#### 5. Enviar Notificação Manual
- **Método**: `POST`
- **URL**: `/api/notify/:estabelecimentoId`
- **Descrição**: Dispara uma notificação para todos os inscritos de um estabelecimento. Pode receber um título e mensagem personalizados.
- **Corpo (JSON, Opcional)**:
  ```json
  {
    "title": "Fornada Especial!",
    "message": "Pão de queijo quentinho saindo agora!"
  }
  ```

---

### Rotas de Autenticação

Rotas para criar e autenticar usuários.

#### 6. Registrar um Novo Usuário
- **Método**: `POST`
- **URL**: `/api/auth/register`
- **Corpo (JSON)**:
  ```json
  {
    "name": "Nome do Usuário",
    "email": "usuario@exemplo.com",
    "password": "senha_forte_123"
  }
  ```

#### 7. Realizar Login
- **Método**: `POST`
- **URL**: `/api/auth/login`
- **Descrição**: Autentica um usuário e retorna um token JWT.
- **Corpo (JSON)**:
  ```json
  {
    "email": "usuario@exemplo.com",
    "password": "senha_forte_123"
  }
  ```
- **Resposta (JSON)**:
  ```json
  {
    "token": "seu_token_jwt_aqui"
  }
  ```

---

### Rotas Autenticadas

As rotas a seguir exigem um token JWT válido no cabeçalho `Authorization: Bearer <seu_token>`.

#### 8. Sincronizar Inscrições
- **Método**: `POST`
- **URL**: `/api/auth/sync`
- **Descrição**: Associa inscrições anônimas ao usuário logado e retorna a lista de estabelecimentos que ele já segue em outros dispositivos.
- **Corpo (JSON)**:
  ```json
  {
    "anonymousEndpoints": [
      "https://fcm.googleapis.com/fcm/send/endpoint_anonimo_1"
    ]
  }
  ```
- **Resposta (JSON)**:
  ```json
  {
    "syncedEstablishmentIds": [1, 5, 12]
  }
  ```

#### 9. Listar Meus Estabelecimentos
- **Método**: `GET`
- **URL**: `/api/users/me/estabelecimentos`
- **Descrição**: Retorna a lista de estabelecimentos que pertencem ao usuário logado.

#### 10. Criar um Novo Estabelecimento
- **Método**: `POST`
- **URL**: `/api/estabelecimentos`
- **Descrição**: Cria um novo estabelecimento associado ao usuário logado.
- **Corpo (JSON)**:
  ```json
  {
    "nome": "Padaria Nova",
    "tipo": "padaria",
    "latitude": -23.123,
    "longitude": -46.456,
    "details": { "horarioAbertura": "06:00", "horarioFechamento": "22:00", "proximaFornada": ["17:00"] }
  }
  ```

#### 11. Atualizar um Estabelecimento
- **Método**: `PUT`
- **URL**: `/api/estabelecimentos/:id`
- **Descrição**: Atualiza os dados de um estabelecimento que pertence ao usuário logado.
- **Corpo (JSON)**: Deve conter todos os campos do estabelecimento.

#### 12. Excluir um Estabelecimento
- **Método**: `DELETE`
- **URL**: `/api/estabelecimentos/:id`
- **Descrição**: Exclui um estabelecimento que pertence ao usuário logado.

---