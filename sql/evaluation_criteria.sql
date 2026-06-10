-- ============================================================================
-- Evaluation Criteria (per-tender)
-- Root of the evaluation flow: defines the weighted criteria used to score bids.
-- Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'EvaluationCriteria')
BEGIN
    CREATE TABLE EvaluationCriteria (
        CriteriaID   VARCHAR(50)   NOT NULL PRIMARY KEY,
        TenderID     VARCHAR(50)   NOT NULL,
        CriteriaName NVARCHAR(255) NOT NULL,
        Description  NVARCHAR(MAX) NULL,
        MaxScore     DECIMAL(9,2)  NOT NULL DEFAULT 0,   -- points available for this criterion
        Weight       DECIMAL(5,2)  NOT NULL DEFAULT 0,   -- percentage contribution (criteria should sum to 100)
        SortOrder    INT           NOT NULL DEFAULT 0,   -- display order
        CreatedAt    DATETIME      NOT NULL DEFAULT GETDATE(),
        UpdatedAt    DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_EvalCriteria_Tender FOREIGN KEY (TenderID)
            REFERENCES Tender(TenderID) ON DELETE CASCADE
    );

    CREATE INDEX IX_EvalCriteria_Tender ON EvaluationCriteria (TenderID);

    PRINT 'EvaluationCriteria table created.';
END
ELSE
    PRINT 'EvaluationCriteria table already exists - skipped.';
