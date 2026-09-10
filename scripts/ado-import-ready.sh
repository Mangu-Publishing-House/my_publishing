#!/usr/bin/env bash
# Import docs/ado/mangu-delivery-import.csv into Azure Boards.
# Needs: Azure CLI + boards extension + PAT.
#
#   az extension add --name azure-devops
#   export AZURE_DEVOPS_EXT_PAT=...   # scopes: Work Items R/W
#   export ADO_ORG=https://dev.azure.com/YOUR_ORG
#   export ADO_PROJECT=YOUR_PROJECT
#   ./scripts/ado-import-ready.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CSV="$ROOT/docs/ado/mangu-delivery-import.csv"

if [[ -z "${ADO_ORG:-}" || -z "${ADO_PROJECT:-}" ]]; then
  echo "Set ADO_ORG (https://dev.azure.com/<org>) and ADO_PROJECT before running." >&2
  echo "This workspace has no Azure DevOps connector — the CSV is the portable artifact." >&2
  echo "UI path: Boards → Queries → Import work items → $CSV" >&2
  exit 2
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI required: https://aka.ms/install-azure-cli" >&2
  exit 1
fi

az devops configure --defaults organization="$ADO_ORG" project="$ADO_PROJECT"

echo "Importing $CSV into $ADO_ORG / $ADO_PROJECT"
echo "Azure CLI has no first-class CSV import; open:"
echo "  $ADO_ORG/$ADO_PROJECT/_boards/queries"
echo "and use Import work items. File: $CSV"
ls -l "$CSV"
