-- ============================================================================
-- Evaluation Criteria Library (global, reusable criteria templates)
-- Managed on the Settings page. A tender's EvaluationCriteria selects from
-- this library. Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'EvaluationCriteriaDirectory')
BEGIN
    CREATE TABLE EvaluationCriteriaDirectory (
        CriteriaID  VARCHAR(50)   NOT NULL PRIMARY KEY,
        Name        NVARCHAR(255) NOT NULL,
        Description NVARCHAR(MAX) NULL,
        MaxScore    DECIMAL(9,2)  NOT NULL DEFAULT 0,   -- default points (overridable per tender)
        Weight      DECIMAL(5,2)  NOT NULL DEFAULT 0,   -- default weight % (overridable per tender)
        CreatedAt   DATETIME      NOT NULL DEFAULT GETDATE(),
        UpdatedAt   DATETIME      NOT NULL DEFAULT GETDATE()
    );
    PRINT 'EvaluationCriteriaDirectory table created.';
END
ELSE
    PRINT 'EvaluationCriteriaDirectory table already exists - skipped.';
GO

-- Link the per-tender criteria rows back to the library criterion they came
-- from. CriteriaName/Description/MaxScore/Weight remain a snapshot on
-- EvaluationCriteria so a tender is unaffected if the library is later edited.
IF EXISTS (SELECT * FROM sys.tables WHERE name = 'EvaluationCriteria')
   AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = 'CriteriaRefID' AND Object_ID = Object_ID('EvaluationCriteria'))
BEGIN
    ALTER TABLE EvaluationCriteria ADD CriteriaRefID VARCHAR(50) NULL;
    PRINT 'Added EvaluationCriteria.CriteriaRefID.';
END
ELSE
    PRINT 'EvaluationCriteria.CriteriaRefID already exists or table missing - skipped.';
