export type TableKey = "gig_platforms" | "job_applications" | "contracting_platforms";

export type ColumnType = "text" | "date" | "enum" | "int" | "url" | "path";

export type ColumnConfig = {
  key: string;
  label: string;
  type: ColumnType;
  editable: boolean;
  required?: boolean;
  enumKey?: keyof typeof ENUMS;
};

export const ENUMS = {
  gig_platform_status: [
    "not_started",
    "applied",
    "waiting",
    "active",
    "blocked",
    "dead",
  ],
  job_stage: [
    "researching",
    "drafting",
    "submitted",
    "interviewing",
    "offer",
    "closed_won",
    "closed_lost",
    "archived",
  ],
  contract_platform_status: [
    "not_started",
    "profile_setup",
    "profile_live",
    "proposal_sent",
    "active_contract",
    "paused",
    "dead",
  ],
  proposal_outcome: [
    "pending",
    "no_response",
    "rejected",
    "interview",
    "hired",
    "withdrawn",
  ],
  engagement_type: ["proposal", "application", "direct_outreach"],
} as const;

export const TABLES: Record<
  TableKey,
  {
    label: string;
    statusField: string;
    columns: ColumnConfig[];
    filters: Array<{ field: string; enumKey: keyof typeof ENUMS }>;
  }
> = {
  gig_platforms: {
    label: "Gig Platforms",
    statusField: "status",
    filters: [{ field: "status", enumKey: "gig_platform_status" }],
    columns: [
      { key: "id", label: "ID", type: "int", editable: false },
      { key: "name", label: "Name", type: "text", editable: true, required: true },
      { key: "url", label: "URL", type: "url", editable: true },
      {
        key: "status",
        label: "Status",
        type: "enum",
        editable: true,
        enumKey: "gig_platform_status",
      },
      { key: "applied_at", label: "Applied At", type: "date", editable: true },
      { key: "next_action", label: "Next Action", type: "text", editable: true },
      { key: "next_action_at", label: "Next Action At", type: "date", editable: true },
      { key: "notes", label: "Notes", type: "text", editable: true },
      { key: "created_at", label: "Created", type: "text", editable: false },
      { key: "updated_at", label: "Updated", type: "text", editable: false },
    ],
  },
  job_applications: {
    label: "Job Applications",
    statusField: "stage",
    filters: [
      { field: "stage", enumKey: "job_stage" },
      { field: "engagement_type", enumKey: "engagement_type" },
      { field: "outcome", enumKey: "proposal_outcome" },
    ],
    columns: [
      { key: "id", label: "ID", type: "int", editable: false },
      {
        key: "role_title",
        label: "Role Title",
        type: "text",
        editable: true,
        required: true,
      },
      {
        key: "company",
        label: "Company",
        type: "text",
        editable: true,
        required: true,
      },
      { key: "source_board", label: "Source Board", type: "text", editable: true },
      { key: "job_posting_url", label: "Posting URL", type: "url", editable: true },
      {
        key: "stage",
        label: "Stage",
        type: "enum",
        editable: true,
        enumKey: "job_stage",
      },
      {
        key: "engagement_type",
        label: "Engagement",
        type: "enum",
        editable: true,
        enumKey: "engagement_type",
      },
      { key: "platform_id", label: "Platform ID", type: "int", editable: true },
      { key: "rate_or_salary", label: "Rate/Salary", type: "text", editable: true },
      { key: "submitted_at", label: "Submitted At", type: "date", editable: true },
      { key: "next_action", label: "Next Action", type: "text", editable: true },
      { key: "next_action_at", label: "Next Action At", type: "date", editable: true },
      { key: "notes", label: "Notes", type: "text", editable: true },
      { key: "local_files_path", label: "Files Path", type: "path", editable: true },
      { key: "connects_spent", label: "Connects Spent", type: "int", editable: true },
      {
        key: "outcome",
        label: "Outcome",
        type: "enum",
        editable: true,
        enumKey: "proposal_outcome",
      },
      { key: "created_at", label: "Created", type: "text", editable: false },
      { key: "updated_at", label: "Updated", type: "text", editable: false },
    ],
  },
  contracting_platforms: {
    label: "Contracting Platforms",
    statusField: "status",
    filters: [{ field: "status", enumKey: "contract_platform_status" }],
    columns: [
      { key: "id", label: "ID", type: "int", editable: false },
      { key: "name", label: "Name", type: "text", editable: true, required: true },
      { key: "url", label: "URL", type: "url", editable: true },
      {
        key: "status",
        label: "Status",
        type: "enum",
        editable: true,
        enumKey: "contract_platform_status",
      },
      { key: "profile_url", label: "Profile URL", type: "url", editable: true },
      { key: "current_rate", label: "Current Rate", type: "text", editable: true },
      { key: "connects_balance", label: "Connects Balance", type: "int", editable: true },
      {
        key: "connects_per_proposal",
        label: "Connects/Proposal",
        type: "int",
        editable: true,
      },
      { key: "submission_notes", label: "Submission Notes", type: "text", editable: true },
      { key: "next_action", label: "Next Action", type: "text", editable: true },
      { key: "next_action_at", label: "Next Action At", type: "date", editable: true },
      { key: "notes", label: "Notes", type: "text", editable: true },
      { key: "profile_files_path", label: "Profile Files Path", type: "path", editable: true },
      { key: "created_at", label: "Created", type: "text", editable: false },
      { key: "updated_at", label: "Updated", type: "text", editable: false },
    ],
  },
};
