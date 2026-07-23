# DATA CLEANSING SOP

### Steps for Monthly CRM Cleansing
1. Export unengaged contacts (no activity > 365 days).
2. Run email bounce verification script.
3. Tag invalid emails with `status: invalid`.
4. Do NOT hard delete; archive for compliance.