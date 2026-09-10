# Azure Boards mirror pack

GitHub Issues stay canonical. This folder is the portable ADO side.

## Why a CSV
This Grok workspace cannot talk to Azure DevOps. There is no ADO connector to attach.

## Import
1. Create or open an Azure DevOps project (any org you already have).
2. Boards → Queries → **Import work items**.
3. Upload `mangu-delivery-import.csv`.
4. After import, link each work item back to its GitHub issue URL in the description.
5. Then install the **Azure Boards** GitHub App on `Mangu-Publishing-House/my_publishing` so new issues labeled `ado:sync` flow across.

## Script
`scripts/ado-import-ready.sh` prints the exact UI target once `ADO_ORG` and `ADO_PROJECT` are set.

Needed from you: org name + project name.
