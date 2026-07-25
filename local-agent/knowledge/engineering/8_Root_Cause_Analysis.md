# ROOT CAUSE ANALYSIS (RCA) / INCIDENT REPORT

**Incident ID:** INC-2026-099  
**Date of Incident:** July 18, 2026  
**Author:** Site Reliability Engineering (SRE) Team  

### 1. Incident Summary
On July 18, 2026, the main payment gateway experienced a 45-minute outage, resulting in failed transactions and a degraded customer experience.

### 2. Timeline
*   **14:00 UTC:** Alerts triggered for elevated 5xx errors on the checkout service.
*   **14:05 UTC:** SRE team begins investigation; identifies database connection pool exhaustion.
*   **14:20 UTC:** Temporary fix applied by restarting the checkout service pods.
*   **14:45 UTC:** Services fully restored and stabilized.

### 3. The "5 Whys"
1.  **Why did the checkout service fail?** It ran out of database connections.
2.  **Why did it run out of connections?** A recent code deployment introduced a query that locked rows for an extended period.
3.  **Why did the query lock rows?** The database index was missing for the newly added query parameter.
4.  **Why was the index missing?** The database migration script was not included in the release package.
5.  **Why was it not included?** Manual oversight during the release preparation process.

### 4. Action Items
*   Automate database migration checks in the CI/CD pipeline. (Owner: DevOps)
*   Add connection pool monitoring alerts. (Owner: SRE)
