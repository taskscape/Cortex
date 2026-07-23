# DISASTER RECOVERY PLAN (DRP)

### Database Infrastructure
* **RPO (Recovery Point Objective):** 15 minutes. Backups are shipped to an off-site region every 15 minutes.
* **RTO (Recovery Time Objective):** 2 hours. Automated failover to the secondary region is scripted via Terraform.