# STANDARD OPERATING PROCEDURE (SOP)

**Title:** Production Deployment Process  
**SOP ID:** ENG-SOP-001  
**Last Updated:** July 21, 2026  

### 1. Purpose
To establish a standardized, safe, and repeatable process for deploying new code to the production environment.

### 2. Scope
Applies to all backend and frontend services maintained by the core engineering team.

### 3. Procedure
1.  **Code Review:** Ensure the Pull Request (PR) has at least two approvals from senior engineers.
2.  **CI/CD Pipeline:** Verify all automated tests (unit, integration, e2e) have passed in Jenkins/GitHub Actions.
3.  **Staging Verification:** Deploy code to the staging environment and perform a manual sanity check.
4.  **Deployment Window:** Deployments must occur during the off-peak maintenance window (Tuesday or Thursday, 02:00 - 04:00 UTC).
5.  **Execution:** Trigger the production deployment pipeline.
6.  **Monitoring:** Monitor Datadog dashboards for 30 minutes post-deployment to observe error rates and latency.

### 4. Rollback Plan
If error rates exceed the 1% threshold, execute the automated rollback script immediately via the deployment portal.
