# Procurement Backend

Express.js backend for the procurement portal. The API supports administrator and
supplier workflows for tenders, bids, supplier registration, document management,
evaluation, notifications, and audit history.

## Tech stack

- Node.js and Express 5
- Microsoft SQL Server via `mssql`
- JWT authentication with administrator and supplier roles
- Azure Blob Storage for supplier documents
- Nodemailer for transactional email
- `node-cron` for tender status updates and closing notifications

## Requirements

- Node.js 18 or newer
- npm
- Access to the configured Microsoft SQL Server database
- Azure credentials with access to the `supplier-documents` Blob Storage container
  when document storage is used

## Installation

```bash
npm install
```

Create a `.env` file in the project root. Do not commit this file.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port. Defaults to `5001`. |
| `JWT_SECRET` | Yes | Secret used to sign and validate access tokens. |
| `DB_SERVER` | Yes | SQL Server host name. |
| `DB_NAME` | Yes | SQL Server database name. |
| `DB_USER` | Yes | SQL Server user name. |
| `DB_PASSWORD` | Yes | SQL Server password. |
| `DB_PORT` | No | SQL Server port. Defaults to `1433`. |
| `AZURE_STORAGE_ACCOUNT_NAME` | When using documents | Azure Storage account name. The application uses `DefaultAzureCredential` and the `supplier-documents` container. |
| `SYNC_API_KEY` | When using sync routes | API key expected in the `x-sync-api-key` request header. |
| `EMAIL_USER` | When sending email | SMTP account used by the mailer. |
| `EMAIL_PASS` | When sending email | SMTP password or application password. |
| `FRONTEND_URL` | When using password reset | Frontend origin used to build reset-password links. |
| `ORG_NAME` | No | Organization name used in email templates. Defaults to `Procurement Portal`. |
| `NODE_ENV` | No | Set to `production` in production deployments. |

Example:

```dotenv
PORT=5001
NODE_ENV=development
JWT_SECRET=replace-with-a-long-random-secret

DB_SERVER=localhost
DB_NAME=ProcurementDB
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_PORT=1433

AZURE_STORAGE_ACCOUNT_NAME=your-storage-account
SYNC_API_KEY=replace-with-a-sync-key

EMAIL_USER=no-reply@example.com
EMAIL_PASS=replace-with-an-app-password
FRONTEND_URL=http://localhost:3000
ORG_NAME=Procurement Portal
```

## Running the API

Start the server in production-like mode:

```bash
npm start
```

Start with Nodemon during development:

```bash
npm run dev
```

The server is available at `http://localhost:5001` by default.

## Health check

The public health endpoint can be used to verify that the HTTP server is running:

```http
GET /api/health
```

Example response:

```json
{
  "status": "OK",
  "message": "Backend running with SQL Server"
}
```

## API overview

All API routes are prefixed with `/api`.

| Route group | Purpose |
| --- | --- |
| `/api/auth` | Administrator and supplier login, password changes, and password reset |
| `/api/tenders` | Tender listing, creation, updates, interests, awards, and evaluation workflows |
| `/api/bids` | Bid submission, review, status changes, and bid document downloads |
| `/api/suppliers` | Supplier registration, profiles, documents, experience, and verification |
| `/api/notifications` | User notifications and read status |
| `/api/admin` | Administrator users, tender status maintenance, and document checks |
| `/api/categories` | Procurement category management |
| `/api/stats` | Procurement statistics |
| `/api/audit` | Administrator-only audit log access |
| `/api/panel-members` | Evaluation panel member directory |
| `/api/criteria-library` | Reusable evaluation criteria |
| `/api/email-templates` | Administrator email template management |
| `/api/sync` | Protected supplier, tender, and document synchronization endpoints |
| `/api/regions`, `/api/cities`, `/api/countries` | Reference data |

Routes that require authentication expect a bearer token:

```http
Authorization: Bearer YOUR_ACCESS_TOKEN
```

Administrator-only routes additionally require the token payload to contain
`role: "admin"`. Synchronization routes use the separate header:

```http
x-sync-api-key: <SYNC_API_KEY>
```

## Database setup

The application connects to SQL Server when it starts. The SQL scripts in
[`sql/`](./sql) add tables used by the evaluation and audit features:

- [`audit_log.sql`](./sql/audit_log.sql) - audit trail
- [`evaluation_criteria.sql`](./sql/evaluation_criteria.sql) - tender evaluation criteria
- [`evaluation_criteria_directory.sql`](./sql/evaluation_criteria_directory.sql) - reusable criteria library
- [`evaluation_panel.sql`](./sql/evaluation_panel.sql) - tender evaluation panels
- [`panel_member_directory.sql`](./sql/panel_member_directory.sql) - reusable panel member directory
- [`preliminary_evaluation.sql`](./sql/preliminary_evaluation.sql) - preliminary evaluations
- [`technical_evaluation.sql`](./sql/technical_evaluation.sql) - technical evaluations

Run the scripts against the configured procurement database using SQL Server
Management Studio, Azure Data Studio, or an equivalent SQL client. They are
idempotent and skip tables that already exist.

## Azure Blob Storage

Supplier documents are stored in the `supplier-documents` container. The backend
uses Azure Identity's `DefaultAzureCredential`, so local development can use an
authenticated Azure CLI, Visual Studio Code, or other supported developer
credential. The deployed identity must have permission to read and write blobs in
the storage account.

## Scheduled jobs

When `server.js` starts, a daily cron job runs at midnight and:

1. Updates tender statuses based on opening and closing dates.
2. Notifies interested suppliers about tenders closing within three days.
3. Notifies administrators about those closing tenders.

The job requires a working SQL Server connection and notification data.

## Project structure

```text
.
├── app.js                 # Express app, middleware, and route mounting
├── server.js              # HTTP server startup and scheduled jobs
├── routes/                # API route modules
├── controllers/           # Reusable controller logic
├── middleware/            # Authentication and request middleware
├── db/                    # SQL Server connection pool
├── helpers/               # Storage, email, notification, and domain helpers
├── jobs/                  # Scheduled background jobs
└── sql/                   # Supplemental database table scripts
```

## Troubleshooting

- **The server exits immediately:** confirm that `JWT_SECRET` is present in `.env`.
- **Database connection errors:** verify `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_PORT`, and confirm the SQL Server accepts encrypted connections.
- **401 responses from sync endpoints:** send the configured value in the `x-sync-api-key` header.
- **401 or 403 responses on protected routes:** send a valid, unexpired JWT using the `Authorization` header and verify the required role.
- **Blob errors:** confirm `AZURE_STORAGE_ACCOUNT_NAME`, Azure credential login, and Blob Storage permissions for the application identity.
- **Email errors:** confirm `EMAIL_USER` and `EMAIL_PASS`; the SMTP host is configured in `helpers/mailers.js`.

## Security notes

- Keep `.env`, database credentials, JWT secrets, API keys, and Azure credentials out
  of source control.
- Use a long, randomly generated `JWT_SECRET` in every deployed environment.
- Set `NODE_ENV=production` in production so development-only password reset data
  is not returned.
- Run the API behind HTTPS in deployed environments.
