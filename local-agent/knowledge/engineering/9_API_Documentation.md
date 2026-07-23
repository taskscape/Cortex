# API DOCUMENTATION

**Service:** Inventory Management API  
**Base URL:** `https://api.company.com/v1/inventory`  

---

### Get Product Inventory
Retrieves the current stock level for a specific product.

**Endpoint:** `GET /{product_id}`

**Headers:**
*   `Authorization: Bearer <token>`
*   `Accept: application/json`

**Path Parameters:**
*   `product_id` (string, required): The unique identifier of the product.

**Success Response (200 OK):**
```json
{
  "product_id": "PROD-9876",
  "stock_level": 145,
  "reserved_stock": 10,
  "warehouse_location": "WH-US-EAST",
  "last_updated": "2026-07-21T08:00:00Z"
}
```

**Error Response (404 Not Found):**
```json
{
  "error": "ProductNotFound",
  "message": "The product ID provided does not exist in the inventory."
}
```
