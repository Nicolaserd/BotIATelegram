# Telegram Chatbot

Backend en NestJS para un bot de Telegram con autenticacion, roles, base de datos PostgreSQL y respuestas asistidas por IA.

Este README esta escrito como documentacion publica. No debe contener tokens, PINs, URLs reales, usuarios reales, contrasenas, cadenas de conexion, prompts internos completos ni valores de variables de entorno.

## Funciones principales

- Recibe mensajes de Telegram por webhook.
- Responde mensajes usando un servicio de IA configurado por variables de entorno.
- Guarda conversaciones en PostgreSQL.
- Cifra el contenido de las conversaciones antes de guardarlo.
- Protege rutas administrativas con JWT y roles.
- Tiene control de uso configurable para el bot.
- Incluye modulos iniciales para usuarios, NLP y Mercado Pago.
- Esta preparado para correr localmente o desplegarse en Vercel.

## Estructura

```txt
src/
  Auth/              Registro, login y JWT
  Users/             Usuarios y carga inicial de datos
  telegram/          Webhook y envio de mensajes por Telegram
  IA/                Servicio de IA (Gemini con fallback a NVIDIA)
  npl/               Procesamiento de texto
  mercado-pago/      Integracion inicial de pagos
  entities/          Entidades de TypeORM
  guards/            Proteccion con JWT y roles
  decorators/        Decoradores compartidos
  enum/              Roles del sistema
  config/            Configuracion de TypeORM
api/
  index.ts           Entrada serverless para Vercel
Docuentos_guia/      Base de conocimiento institucional (.md) que el bot
                     consulta y CITA al responder. Solo se incluyen documentos
                     con contenido real; los archivos vacios deben omitirse.
```

## Variables de entorno

Crea un archivo `.env` local y configura los valores reales solo ahi o en el panel de variables de entorno del proveedor de despliegue.

```env
DATABASE_URL=
DB_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=
JWT_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
GOOGLE_AI_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=
NVIDIA_API_KEY=
NVIDIA_MODEL=
BOT_UNLOCK_PIN=
CONVERSATION_ENCRYPTION_KEY=
```

Notas:

- `DATABASE_URL` se usa para una conexion completa a PostgreSQL.
- Si no existe `DATABASE_URL`, la app intenta usar `DB_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB`.
- `GOOGLE_AI_API_KEY` o `GEMINI_API_KEY` habilita las respuestas con IA (proveedor primario).
- `NVIDIA_API_KEY` habilita el fallback automatico cuando Gemini falla. `NVIDIA_MODEL` es opcional.
- `TELEGRAM_WEBHOOK_SECRET` es recomendado para validar llamadas entrantes de Telegram.
- `CONVERSATION_ENCRYPTION_KEY` debe ser una clave larga y privada.
- `BOT_UNLOCK_PIN` debe tratarse como secreto.

## Seguridad

- No subas archivos `.env` al repositorio.
- No publiques tokens de Telegram, claves de IA, secretos JWT, PINs, cadenas de conexion ni URLs privadas.
- No pongas valores reales en ejemplos del README.
- Rota de inmediato cualquier credencial que haya sido publicada, incluso si ya fue eliminada del archivo.
- Si un secreto llego a un commit remoto, considera limpiar el historial o invalidar el secreto en el proveedor correspondiente.

## Telegram

El bot recibe eventos en la ruta de webhook y envia respuestas mediante la Bot API de Telegram.

Flujo general:

1. Crear el bot con BotFather.
2. Guardar el token en variables de entorno.
3. Desplegar la API en una URL publica HTTPS.
4. Registrar el webhook en Telegram usando el token del bot.
5. Enviar mensajes al bot desde Telegram.

Usa siempre valores privados desde variables de entorno cuando registres el webhook.

### Webhook asincronico

El endpoint `POST /telegram/webhook` valida el header de secreto y responde
`200 { ok: true }` de inmediato. La generacion de la respuesta de IA y el envio
del mensaje al chat ocurren en segundo plano dentro de la misma funcion
serverless. Esto evita que Telegram reintente el webhook por timeouts mientras
el modelo esta pensando.

Implicaciones:

- La funcion debe permanecer viva el tiempo suficiente para terminar el trabajo
  en background (ver `maxDuration` en la seccion de Deploy).
- El cuerpo de la respuesta del webhook ya no expone metadatos como `attemptNumber`;
  esos detalles se procesan internamente.
- El throttle por chat (`processingChats`) sigue activo, pero es in-memory y por
  instancia: para un candado fuerte entre invocaciones haria falta Redis o KV.

## Autenticacion

El proyecto incluye registro, login con JWT y proteccion por roles.

Rutas principales:

- `POST /auth/singup`
- `POST /auth/singin`

Nota: los nombres actuales de las rutas estan escritos como `singup` y `singin`.

## Base de datos

El proyecto usa PostgreSQL con TypeORM.

Entidades principales:

- `Users`
- `Messages`
- `TelegramConversation`
- `Products`
- `Proveedores`

La configuracion de TypeORM esta en `src/config/typeorm.ts`.

Para proteger datos en una base real, revisa con cuidado:

```ts
synchronize: true,
dropSchema: false,
```

No uses `dropSchema: true` en una base de datos con datos importantes.

## Correr localmente

Instala dependencias:

```bash
npm install
```

Crea `.env` con tus valores reales y ejecuta:

```bash
npm run start:dev
```

La API local queda disponible en:

```txt
http://localhost:3000
```

## Deploy

Este proyecto incluye `api/index.ts` y `vercel.json` para desplegar en Vercel.

Antes de desplegar, configura las variables de entorno reales en Vercel. No las agregues al README ni a archivos versionados.

Configuracion relevante de `vercel.json`:

- `includeFiles: "Docuentos_guia/**"` empaqueta la base de conocimiento dentro
  del bundle serverless para que `IaService` pueda leerla en runtime.
- `maxDuration: 60` permite que la funcion siga viva hasta 60s mientras
  termina el trabajo asincronico del webhook (Gemini + envio a Telegram).
  Ajusta segun el plan de Vercel: Hobby admite hasta 60s, Pro mas.

Preview:

```bash
npx vercel@latest deploy
```

Produccion:

```bash
npx vercel@latest deploy --prod
```

## Comandos utiles

```bash
npm run start
npm run start:dev
npm run build
npm run test
npm run lint
```
