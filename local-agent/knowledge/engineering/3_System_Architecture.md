# SYSTEM ARCHITECTURE

**System:** Global E-Commerce Platform  
**Version:** 3.2  

### 1. High-Level Design
The system utilizes a multi-region active-active cloud deployment on AWS. Traffic is routed via Route 53 to an Application Load Balancer.

### 2. Core Components
*   **Frontend:** React Single Page Application hosted on S3 and delivered via CloudFront CDN.
*   **Backend Services:** Kubernetes cluster (EKS) running Node.js and Python microservices.
*   **Message Broker:** Apache Kafka for asynchronous event processing (e.g., order confirmation, inventory updates).
*   **Database Tier:** 
    *   Primary Data: Amazon Aurora (PostgreSQL compatible).
    *   NoSQL/Caching: Amazon DynamoDB and ElastiCache (Redis).

### 3. External Integrations
*   Stripe (Payment Processing)
*   SendGrid (Transactional Emails)
*   Twilio (SMS Notifications)

### 4. Architecture Diagram (Text Representation)
`Client -> CDN -> WAF -> API Gateway -> Microservices (EKS) -> Databases/Caches`
