-- ============================================================================
-- Audit Trail table
-- Run this once against PROCUREMENTDB to enable the audit log.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditLog')
BEGIN
    CREATE TABLE AuditLog (
        AuditID       VARCHAR(50)   NOT NULL PRIMARY KEY,
        UserID        VARCHAR(50)   NULL,          -- actor (UserID for admin, SupplierID for supplier); NULL for anonymous/failed events
        UserRole      NVARCHAR(50)  NULL,          -- 'admin' | 'supplier' | 'system'
        UserEmail     NVARCHAR(255) NULL,          -- actor email captured at the time of the action
        Action        NVARCHAR(100) NOT NULL,      -- machine code, e.g. 'TENDER_CREATE', 'LOGIN_SUCCESS'
        EntityType    NVARCHAR(50)  NULL,          -- 'Tender' | 'Bid' | 'Supplier' | 'Auth' | 'AdminUser' | 'Category' | 'Document'
        EntityID      VARCHAR(50)   NULL,          -- id of the affected record, when applicable
        Description   NVARCHAR(500) NULL,          -- human-readable summary
        IPAddress     NVARCHAR(64)  NULL,          -- client IP at time of action
        UserAgent     NVARCHAR(500) NULL,          -- client browser / device user-agent
        Timestamp     DATETIME      NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX IX_AuditLog_Timestamp ON AuditLog (Timestamp DESC);
    CREATE INDEX IX_AuditLog_Entity    ON AuditLog (EntityType, EntityID);
    CREATE INDEX IX_AuditLog_User      ON AuditLog (UserID);

    PRINT 'AuditLog table created.';
END
ELSE
    PRINT 'AuditLog table already exists - skipped.';
