# DATA QUALITY RULES

### Domain: Customer Emails
1. **Completeness:** `email` field cannot be null.
2. **Validity:** Must match standard RegEx `^[^@]+@[^@]+\.[^@]+$`.
3. **Uniqueness:** No two active customers can have the same email address.