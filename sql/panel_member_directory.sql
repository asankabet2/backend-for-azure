-- ============================================================================
-- Panel Member Directory (global roster of evaluators)
-- Created/managed on the Settings page. A tender's EvaluationPanel selects
-- members from this directory. Run once against PROCUREMENTDB.
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PanelMemberDirectory')
BEGIN
    CREATE TABLE PanelMemberDirectory (
        MemberID    VARCHAR(50)   NOT NULL PRIMARY KEY,
        Name        NVARCHAR(255) NOT NULL,
        Designation NVARCHAR(255) NULL,
        Department  NVARCHAR(255) NULL,
        Email       NVARCHAR(255) NULL,
        CreatedAt   DATETIME      NOT NULL DEFAULT GETDATE(),
        UpdatedAt   DATETIME      NOT NULL DEFAULT GETDATE()
    );
    PRINT 'PanelMemberDirectory table created.';
END
ELSE
    PRINT 'PanelMemberDirectory table already exists - skipped.';
GO

-- Link the per-tender panel rows back to the directory member they came from.
-- Name/Designation/Department remain a snapshot on EvaluationPanel so panels are
-- unaffected if a directory entry is later edited or deleted.
IF EXISTS (SELECT * FROM sys.tables WHERE name = 'EvaluationPanel')
   AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = 'DirectoryMemberID' AND Object_ID = Object_ID('EvaluationPanel'))
BEGIN
    ALTER TABLE EvaluationPanel ADD DirectoryMemberID VARCHAR(50) NULL;
    PRINT 'Added EvaluationPanel.DirectoryMemberID.';
END
ELSE
    PRINT 'EvaluationPanel.DirectoryMemberID already exists or table missing - skipped.';
