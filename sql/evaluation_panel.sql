-- ============================================================================
-- Evaluation Panel (per-tender committee members)
-- The people who evaluate this tender. Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'EvaluationPanel')
BEGIN
    CREATE TABLE EvaluationPanel (
        PanelMemberID VARCHAR(50)   NOT NULL PRIMARY KEY,
        TenderID      VARCHAR(50)   NOT NULL,
        MemberName    NVARCHAR(255) NOT NULL,
        Designation   NVARCHAR(255) NULL,
        Department    NVARCHAR(255) NULL,
        Role          NVARCHAR(50)  NOT NULL DEFAULT 'Member',   -- Chairperson | Secretary | Member
        Status        NVARCHAR(50)  NOT NULL DEFAULT 'Pending',  -- Pending | Confirmed
        CreatedAt     DATETIME      NOT NULL DEFAULT GETDATE(),
        UpdatedAt     DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_EvalPanel_Tender FOREIGN KEY (TenderID)
            REFERENCES Tender(TenderID) ON DELETE CASCADE
    );

    CREATE INDEX IX_EvalPanel_Tender ON EvaluationPanel (TenderID);

    PRINT 'EvaluationPanel table created.';
END
ELSE
    PRINT 'EvaluationPanel table already exists - skipped.';
