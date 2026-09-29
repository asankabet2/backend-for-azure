-- ============================================================================
-- Technical Evaluation — one row per bid.
-- Score columns are the tender's selected EvaluationCriteria; per-criterion raw
-- scores are stored as JSON. Weighted Total (%) and Outcome are computed
-- server-side against a pass mark. Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TechnicalEvaluation')
BEGIN
    CREATE TABLE TechnicalEvaluation (
        TechID      VARCHAR(50)   NOT NULL PRIMARY KEY,
        TenderID    VARCHAR(50)   NOT NULL,
        BidID       VARCHAR(50)   NOT NULL,
        Scores      NVARCHAR(MAX) NULL,                       -- JSON: { "<criteriaId>": <rawScore> }
        Total       DECIMAL(6,2)  NOT NULL DEFAULT 0,          -- weighted total, normalised to 0-100
        Outcome     NVARCHAR(20)  NOT NULL DEFAULT 'Pending',  -- Pass | Fail | Pending
        EvaluatedAt DATETIME      NULL,
        UpdatedAt   DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_Tech_Bid UNIQUE (BidID),
        CONSTRAINT FK_Tech_Bid FOREIGN KEY (BidID)
            REFERENCES Bid(BidID) ON DELETE CASCADE
    );

    CREATE INDEX IX_Tech_Tender ON TechnicalEvaluation (TenderID);

    PRINT 'TechnicalEvaluation table created.';
END
ELSE
    PRINT 'TechnicalEvaluation table already exists - skipped.';


HMS
CREATE TABLE TenderInterest (
    TenderID      VARCHAR(50)  NOT NULL,
    SupplierID    VARCHAR(50)  NOT NULL,
    InterestDate  DATE         NOT NULL,
    SyncedAt      DATETIME     NOT NULL CONSTRAINT DF_TenderInterest_SyncedAt DEFAULT GETDATE(),
    CONSTRAINT PK_TenderInterest PRIMARY KEY CLUSTERED (TenderID, SupplierID)
);

CREATE NONCLUSTERED INDEX IX_TenderInterest_SupplierID
    ON TenderInterest (SupplierID);

CREATE NONCLUSTERED INDEX IX_TenderInterest_InterestDate
    ON TenderInterest (InterestDate);
