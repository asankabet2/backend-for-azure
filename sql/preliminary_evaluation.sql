-- ============================================================================
-- Preliminary (Administrative) Evaluation — one row per bid.
-- The checklist columns are the tender's Required Documents; per-document
-- Pass/Fail results are stored as JSON (same pattern as SupplierProfile.Documents).
-- Outcome is computed server-side. Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PreliminaryEvaluation')
BEGIN
    CREATE TABLE PreliminaryEvaluation (
        PrelimID    VARCHAR(50)   NOT NULL PRIMARY KEY,
        TenderID    VARCHAR(50)   NOT NULL,
        BidID       VARCHAR(50)   NOT NULL,
        Results     NVARCHAR(MAX) NULL,                       -- JSON: { "<docKey>": "Pass" | "Fail" }
        Remarks     NVARCHAR(MAX) NULL,
        Outcome     NVARCHAR(20)  NOT NULL DEFAULT 'Pending',  -- Pass | Fail | Pending
        EvaluatedAt DATETIME      NULL,
        UpdatedAt   DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_Prelim_Bid UNIQUE (BidID),
        CONSTRAINT FK_Prelim_Bid FOREIGN KEY (BidID)
            REFERENCES Bid(BidID) ON DELETE CASCADE
    );

    CREATE INDEX IX_Prelim_Tender ON PreliminaryEvaluation (TenderID);

    PRINT 'PreliminaryEvaluation table created.';
END
ELSE
    PRINT 'PreliminaryEvaluation table already exists - skipped.';
