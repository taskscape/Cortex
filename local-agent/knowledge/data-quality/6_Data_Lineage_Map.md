# DATA LINEAGE DOCUMENTATION

### Field: `annual_revenue`
1. **Origin:** Input manually by Sales in Salesforce.
2. **Transformation:** Aggregated via Fivetran nightly sync.
3. **Destination:** Snowflake Data Warehouse `dim_company` table.
4. **Consumption:** Looker Executive Dashboard.