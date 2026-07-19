# Cloudflare infrastructure as code (CLD-012, NFR-037). Skeleton only: declares
# the resource surface so environments are reproducible from code with scoped
# tokens and NO secrets committed. Real IDs/keys are supplied per environment via
# TF variables backed by a secure secret store, never literals here.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4"
    }
  }
}

variable "cloudflare_account_id" { type = string }
variable "environment" {
  type    = string
  default = "staging"
}

# --- R2: private buckets for documents, reports, encrypted backups (CLD-006).
resource "cloudflare_r2_bucket" "documents" {
  account_id = var.cloudflare_account_id
  name       = "sancta-documents-${var.environment}"
  location   = "WEUR" # placeholder — approved jurisdiction is a blocking decision (B2/NFR-032)
}

resource "cloudflare_r2_bucket" "reports" {
  account_id = var.cloudflare_account_id
  name       = "sancta-reports-${var.environment}"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = "sancta-backups-${var.environment}"
  location   = "WEUR"
}

# --- Queues: sync application, notifications, reports, integrations (CLD-003).
#     Each with a dead-letter queue and monitored retry (NFR-036).
resource "cloudflare_queue" "sync_apply" {
  account_id = var.cloudflare_account_id
  name       = "sancta-sync-apply-${var.environment}"
}
resource "cloudflare_queue" "sync_apply_dlq" {
  account_id = var.cloudflare_account_id
  name       = "sancta-sync-apply-dlq-${var.environment}"
}

# --- Hyperdrive: cache-disabled binding to managed PostgreSQL (CLD-004/005).
#     The connection string is a secret variable, never a literal.
variable "postgres_connection_string" {
  type      = string
  sensitive = true
}
# resource "cloudflare_hyperdrive_config" "primary" {
#   account_id = var.cloudflare_account_id
#   name       = "sancta-pg-${var.environment}"
#   origin = { ... }              # from var.postgres_connection_string
#   caching = { disabled = true } # freshness-critical paths (NFR-035)
# }

# --- Access, WAF and rate limiting (CLD-008/009) are declared alongside the
#     zone/route resources once the account, zone and IdP (blocking decision B7)
#     are confirmed.

output "r2_buckets" {
  value = [
    cloudflare_r2_bucket.documents.name,
    cloudflare_r2_bucket.reports.name,
    cloudflare_r2_bucket.backups.name,
  ]
}
