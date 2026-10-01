-- What the initial public release (dee2a03e) leaves on PostgreSQL: its
-- init_db runs create_all, stamps v1..v7 and then fails at v8. Rows were
-- written through that release's models. Produced with
--   pg_dump --no-owner --no-privileges --column-inserts --no-comments
-- with SET lines and comments removed and the ``public.`` qualifier stripped,
-- so it loads into whatever schema the connection's search_path names.
-- Used by tests/test_migration_ladder.py; do not regenerate from newer code.
CREATE TABLE adaptive_task_states (
    id character varying NOT NULL,
    schedule_id character varying NOT NULL,
    task_id character varying NOT NULL,
    task_path character varying NOT NULL,
    current_interval_days double precision NOT NULL,
    ease_factor double precision NOT NULL,
    consecutive_passes integer NOT NULL,
    last_run_at timestamp without time zone,
    last_status character varying,
    next_run_at timestamp without time zone
);
CREATE TABLE agent_task_batch_runs (
    id character varying NOT NULL,
    project character varying NOT NULL,
    selection_type character varying NOT NULL,
    selection_query json,
    task_root character varying,
    grep character varying,
    environment character varying NOT NULL,
    run_metadata json,
    status character varying NOT NULL,
    total_tasks integer NOT NULL,
    passed_tasks integer NOT NULL,
    failed_tasks integer NOT NULL,
    errored_tasks integer NOT NULL,
    total_checks integer NOT NULL,
    passed_checks integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    trace_persistence_status character varying NOT NULL,
    trace_error_message character varying,
    task_source_type character varying,
    task_source_ref character varying,
    task_source_commit_sha character varying,
    task_source_subpath character varying
);
CREATE TABLE agent_task_runs (
    id character varying NOT NULL,
    batch_run_id character varying NOT NULL,
    task_id character varying NOT NULL,
    task_path character varying NOT NULL,
    adapter_name character varying,
    status character varying NOT NULL,
    pass_result boolean,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    trace_run_id character varying,
    error_message character varying,
    trace_persistence_status character varying NOT NULL,
    trace_error_message character varying,
    checks_json json,
    transcript_json json,
    deliverables_json json,
    total_cost double precision,
    total_tokens integer,
    task_inventory_id character varying,
    task_source_commit_sha character varying
);
CREATE TABLE agent_task_schedules (
    id character varying NOT NULL,
    project character varying NOT NULL,
    name character varying NOT NULL,
    selection_type character varying NOT NULL,
    selection_query json,
    task_root character varying,
    grep character varying,
    environment character varying NOT NULL,
    cadence_type character varying NOT NULL,
    timezone character varying NOT NULL,
    hour integer NOT NULL,
    minute integer NOT NULL,
    day_of_week integer,
    day_of_month integer,
    min_interval_days double precision NOT NULL,
    max_interval_days double precision NOT NULL,
    enabled boolean NOT NULL,
    last_triggered_at timestamp without time zone,
    last_batch_run_id character varying,
    next_run_at timestamp without time zone,
    run_metadata json,
    task_source_type character varying,
    task_source_ref character varying,
    task_source_subpath character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE annotation_queues (
    id integer NOT NULL,
    project character varying NOT NULL,
    name character varying NOT NULL,
    target_type character varying NOT NULL,
    score_config_id integer,
    total_items integer NOT NULL,
    completed_items integer NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE annotation_queues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE annotation_queues_id_seq OWNED BY annotation_queues.id;
CREATE TABLE api_keys (
    id character varying NOT NULL,
    name character varying NOT NULL,
    public_key character varying,
    hashed_secret_key character varying,
    display_secret_key character varying NOT NULL,
    hashed_key character varying,
    prefix character varying NOT NULL,
    project character varying NOT NULL,
    created_by character varying NOT NULL,
    scope character varying NOT NULL,
    expires_at timestamp without time zone,
    last_used_at timestamp without time zone,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE call_metrics (
    id integer NOT NULL,
    call_id character varying NOT NULL,
    project character varying DEFAULT 'default'::character varying NOT NULL,
    metric_name character varying NOT NULL,
    metric_type character varying NOT NULL,
    score double precision,
    string_value character varying,
    data_type character varying NOT NULL,
    source character varying NOT NULL,
    config_id integer,
    reasoning character varying,
    metadata json,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE call_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE call_metrics_id_seq OWNED BY call_metrics.id;
CREATE TABLE comment_reactions (
    id integer NOT NULL,
    comment_id character varying NOT NULL,
    emoji character varying NOT NULL,
    user_id character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE comment_reactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE comment_reactions_id_seq OWNED BY comment_reactions.id;
CREATE TABLE comments (
    id character varying NOT NULL,
    project_id character varying NOT NULL,
    object_id character varying NOT NULL,
    object_type character varying NOT NULL,
    content text,
    author_id character varying,
    author_name character varying,
    parent_comment_id character varying,
    mentioned_user_ids json,
    selection_field character varying,
    selection_path json,
    selection_range_start json,
    selection_range_end json,
    selected_text character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE email_verification_tokens (
    id character varying NOT NULL,
    user_id character varying NOT NULL,
    code_hash character varying NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    used_at timestamp without time zone,
    attempts integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE github_connections (
    id character varying NOT NULL,
    project character varying NOT NULL,
    github_user_id character varying NOT NULL,
    github_username character varying,
    access_token_encrypted character varying NOT NULL,
    scopes_granted character varying,
    token_type character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE logged_calls (
    id character varying NOT NULL,
    project character varying NOT NULL,
    task_id character varying NOT NULL,
    run_id character varying,
    flow_name character varying,
    step_name character varying,
    step_index integer,
    version character varying,
    created_at timestamp without time zone NOT NULL,
    model character varying NOT NULL,
    latency_ms double precision,
    cost double precision,
    parent_call_id character varying,
    observation_type character varying NOT NULL,
    level character varying NOT NULL,
    status_message character varying,
    completion_start_time timestamp without time zone,
    end_time timestamp without time zone,
    prompt_tokens integer,
    completion_tokens integer,
    session_id character varying,
    environment character varying NOT NULL,
    tags json,
    total_tokens integer,
    prompt_id character varying,
    prompt_version integer,
    provided_cost double precision,
    calculated_cost double precision,
    time_to_first_token_ms double precision,
    provided_model_name character varying,
    internal_model_id character varying,
    tool_name character varying,
    tool_parameters json,
    tool_result json,
    corrected_output character varying,
    input json,
    messages json,
    output json,
    user_id character varying,
    row_id integer NOT NULL,
    metadata json
);
CREATE SEQUENCE logged_calls_row_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE logged_calls_row_id_seq OWNED BY logged_calls.row_id;
CREATE TABLE model_definitions (
    id integer NOT NULL,
    project character varying NOT NULL,
    model_name character varying NOT NULL,
    match_pattern character varying NOT NULL,
    provider character varying NOT NULL,
    input_price double precision NOT NULL,
    output_price double precision NOT NULL,
    cached_input_price double precision,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE model_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE model_definitions_id_seq OWNED BY model_definitions.id;
CREATE TABLE otlp_ingest_batches (
    id character varying NOT NULL,
    project_id character varying NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    content_type character varying NOT NULL,
    payload_sha256 character varying NOT NULL,
    payload text,
    accepted_span_count integer NOT NULL,
    rejected_span_count integer NOT NULL,
    content_policy character varying NOT NULL,
    verified_task_run_id character varying,
    processing_started_at timestamp with time zone,
    status character varying NOT NULL,
    error_message character varying
);
CREATE TABLE otlp_spans (
    id integer NOT NULL,
    project_id character varying NOT NULL,
    trace_id character varying NOT NULL,
    span_id character varying NOT NULL,
    parent_span_id character varying,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    span_name character varying NOT NULL,
    span_kind integer NOT NULL,
    status_code integer NOT NULL,
    status_message character varying,
    trace_flags integer NOT NULL,
    trace_state character varying,
    resource json,
    instrumentation_scope json,
    attributes json,
    events json,
    links json,
    raw_span json,
    content_policy character varying NOT NULL,
    projection_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE otlp_spans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE otlp_spans_id_seq OWNED BY otlp_spans.id;
CREATE TABLE password_reset_tokens (
    id character varying NOT NULL,
    user_id character varying NOT NULL,
    token_hash character varying NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    used_at timestamp without time zone,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE project_invitations (
    id character varying NOT NULL,
    project_id character varying NOT NULL,
    email character varying NOT NULL,
    role character varying NOT NULL,
    invited_by_user_id character varying NOT NULL,
    token_hash character varying NOT NULL,
    invite_url_path character varying,
    delivery_method character varying NOT NULL,
    expires_at timestamp with time zone,
    accepted_at timestamp with time zone,
    accepted_by_user_id character varying,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE project_memberships (
    id character varying NOT NULL,
    project_id character varying NOT NULL,
    user_id character varying NOT NULL,
    role character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE project_task_inventory (
    id character varying NOT NULL,
    project character varying NOT NULL,
    task_source_id character varying NOT NULL,
    task_id character varying NOT NULL,
    display_name character varying NOT NULL,
    adapter_name character varying,
    folder_path character varying NOT NULL,
    task_path character varying NOT NULL,
    has_checks boolean NOT NULL,
    has_user_simulator boolean NOT NULL,
    tags_json json,
    source_type character varying NOT NULL,
    source_ref character varying,
    source_commit_sha character varying,
    source_subpath character varying,
    discovered_at timestamp with time zone DEFAULT now()
);
CREATE TABLE project_task_sources (
    id character varying NOT NULL,
    project character varying NOT NULL,
    source_type character varying NOT NULL,
    display_name character varying NOT NULL,
    repository_url character varying,
    git_ref character varying,
    subpath character varying,
    filesystem_path character varying,
    demo_seed_id character varying,
    status character varying NOT NULL,
    last_synced_at timestamp with time zone,
    last_resolved_commit_sha character varying,
    last_error character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE projects (
    id character varying NOT NULL,
    name character varying NOT NULL,
    trace_content_policy character varying NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE run_metrics (
    id integer NOT NULL,
    run_id character varying NOT NULL,
    project character varying DEFAULT 'default'::character varying NOT NULL,
    metric_name character varying NOT NULL,
    metric_type character varying NOT NULL,
    score double precision,
    string_value character varying,
    data_type character varying NOT NULL,
    source character varying NOT NULL,
    config_id integer,
    reasoning character varying,
    metadata json,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE run_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE run_metrics_id_seq OWNED BY run_metrics.id;
CREATE TABLE runs (
    row_id integer NOT NULL,
    id character varying NOT NULL,
    project character varying NOT NULL,
    task_id character varying,
    flow_name character varying,
    version character varying,
    user_id character varying,
    session_id character varying,
    environment character varying NOT NULL,
    external_id character varying,
    tags json,
    metadata json,
    input json,
    output json,
    primary_model character varying,
    bookmarked boolean NOT NULL,
    is_public boolean NOT NULL,
    task_run_id character varying,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp without time zone,
    duration_ms double precision,
    call_count integer NOT NULL
);
CREATE SEQUENCE runs_row_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE runs_row_id_seq OWNED BY runs.row_id;
CREATE TABLE schema_migrations (
    version integer NOT NULL
);
CREATE TABLE score_configs (
    id integer NOT NULL,
    project character varying NOT NULL,
    name character varying NOT NULL,
    data_type character varying NOT NULL,
    min_value double precision,
    max_value double precision,
    categories json,
    description character varying,
    is_archived boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE score_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE score_configs_id_seq OWNED BY score_configs.id;
CREATE TABLE sessions (
    id character varying NOT NULL,
    project character varying NOT NULL,
    user_id character varying,
    environment character varying NOT NULL,
    metadata json,
    tags json,
    created_at timestamp with time zone DEFAULT now(),
    ended_at timestamp without time zone,
    run_count integer NOT NULL,
    total_cost double precision,
    total_tokens integer
);
CREATE TABLE users (
    id character varying NOT NULL,
    email character varying NOT NULL,
    name character varying NOT NULL,
    password_hash character varying NOT NULL,
    is_admin boolean NOT NULL,
    is_active boolean NOT NULL,
    email_verified_at timestamp without time zone,
    token_invalid_before timestamp without time zone,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE webhooks (
    id integer NOT NULL,
    project character varying NOT NULL,
    url character varying NOT NULL,
    description character varying,
    events json,
    secret character varying NOT NULL,
    enabled boolean NOT NULL,
    last_delivery_at timestamp without time zone,
    last_delivery_status character varying,
    consecutive_failures integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE webhooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE webhooks_id_seq OWNED BY webhooks.id;
ALTER TABLE ONLY annotation_queues ALTER COLUMN id SET DEFAULT nextval('annotation_queues_id_seq'::regclass);
ALTER TABLE ONLY call_metrics ALTER COLUMN id SET DEFAULT nextval('call_metrics_id_seq'::regclass);
ALTER TABLE ONLY comment_reactions ALTER COLUMN id SET DEFAULT nextval('comment_reactions_id_seq'::regclass);
ALTER TABLE ONLY logged_calls ALTER COLUMN row_id SET DEFAULT nextval('logged_calls_row_id_seq'::regclass);
ALTER TABLE ONLY model_definitions ALTER COLUMN id SET DEFAULT nextval('model_definitions_id_seq'::regclass);
ALTER TABLE ONLY otlp_spans ALTER COLUMN id SET DEFAULT nextval('otlp_spans_id_seq'::regclass);
ALTER TABLE ONLY run_metrics ALTER COLUMN id SET DEFAULT nextval('run_metrics_id_seq'::regclass);
ALTER TABLE ONLY runs ALTER COLUMN row_id SET DEFAULT nextval('runs_row_id_seq'::regclass);
ALTER TABLE ONLY score_configs ALTER COLUMN id SET DEFAULT nextval('score_configs_id_seq'::regclass);
ALTER TABLE ONLY webhooks ALTER COLUMN id SET DEFAULT nextval('webhooks_id_seq'::regclass);
INSERT INTO agent_task_batch_runs (id, project, selection_type, selection_query, task_root, grep, environment, run_metadata, status, total_tasks, passed_tasks, failed_tasks, errored_tasks, total_checks, passed_checks, created_at, started_at, completed_at, trace_persistence_status, trace_error_message, task_source_type, task_source_ref, task_source_commit_sha, task_source_subpath) VALUES ('b1', 'p1', 'task', 'null', NULL, NULL, 'default', 'null', 'completed', 0, 0, 0, 0, 0, 0, '2026-01-01 00:00:00+00', NULL, NULL, 'pending', NULL, NULL, NULL, NULL, NULL);
INSERT INTO agent_task_runs (id, batch_run_id, task_id, task_path, adapter_name, status, pass_result, started_at, completed_at, trace_run_id, error_message, trace_persistence_status, trace_error_message, checks_json, transcript_json, deliverables_json, total_cost, total_tokens, task_inventory_id, task_source_commit_sha) VALUES ('r1', 'b1', 't', '/t', NULL, 'failed', false, '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', NULL, NULL, 'pending', NULL, '[{"id": "a", "pass": true}, {"id": "b", "pass": false}]', 'null', 'null', NULL, NULL, NULL, NULL);
INSERT INTO logged_calls (id, project, task_id, run_id, flow_name, step_name, step_index, version, created_at, model, latency_ms, cost, parent_call_id, observation_type, level, status_message, completion_start_time, end_time, prompt_tokens, completion_tokens, session_id, environment, tags, total_tokens, prompt_id, prompt_version, provided_cost, calculated_cost, time_to_first_token_ms, provided_model_name, internal_model_id, tool_name, tool_parameters, tool_result, corrected_output, input, messages, output, user_id, row_id, metadata) VALUES ('g1', 'p1', 'r1', 'trace-1', NULL, NULL, NULL, NULL, '2026-01-01 00:00:00', 'm-first', NULL, 0.0025, NULL, 'GENERATION', 'DEFAULT', NULL, NULL, NULL, NULL, NULL, NULL, 'default', '[]', NULL, NULL, NULL, 0.003, NULL, NULL, NULL, 'gpt-4o-legacy', NULL, 'null', 'null', NULL, NULL, NULL, NULL, NULL, 1, 'null');
INSERT INTO project_memberships (id, project_id, user_id, role, created_at, updated_at) VALUES ('m1', 'p1', 'u1', 'owner', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00');
INSERT INTO projects (id, name, trace_content_policy, created_by, created_at, updated_at) VALUES ('p1', 'P1', 'full', 'u1', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00');
INSERT INTO runs (row_id, id, project, task_id, flow_name, version, user_id, session_id, environment, external_id, tags, metadata, input, output, primary_model, bookmarked, is_public, task_run_id, created_at, completed_at, duration_ms, call_count) VALUES (1, 'trace-1', 'p1', NULL, NULL, NULL, NULL, NULL, 'default', NULL, '[]', 'null', 'null', 'null', NULL, false, false, 'r1', '2026-01-01 00:00:00+00', NULL, NULL, 0);
INSERT INTO schema_migrations (version) VALUES (1);
INSERT INTO schema_migrations (version) VALUES (2);
INSERT INTO schema_migrations (version) VALUES (3);
INSERT INTO schema_migrations (version) VALUES (4);
INSERT INTO schema_migrations (version) VALUES (5);
INSERT INTO schema_migrations (version) VALUES (6);
INSERT INTO schema_migrations (version) VALUES (7);
INSERT INTO users (id, email, name, password_hash, is_admin, is_active, email_verified_at, token_invalid_before, created_at) VALUES ('u1', 'u1@example.com', 'U', 'x', false, true, NULL, NULL, '2026-01-01 00:00:00+00');
SELECT pg_catalog.setval('annotation_queues_id_seq', 1, false);
SELECT pg_catalog.setval('call_metrics_id_seq', 1, false);
SELECT pg_catalog.setval('comment_reactions_id_seq', 1, false);
SELECT pg_catalog.setval('logged_calls_row_id_seq', 1, true);
SELECT pg_catalog.setval('model_definitions_id_seq', 1, false);
SELECT pg_catalog.setval('otlp_spans_id_seq', 1, false);
SELECT pg_catalog.setval('run_metrics_id_seq', 1, false);
SELECT pg_catalog.setval('runs_row_id_seq', 1, true);
SELECT pg_catalog.setval('score_configs_id_seq', 1, false);
SELECT pg_catalog.setval('webhooks_id_seq', 1, false);
ALTER TABLE ONLY adaptive_task_states
    ADD CONSTRAINT adaptive_task_states_pkey PRIMARY KEY (id);
ALTER TABLE ONLY agent_task_batch_runs
    ADD CONSTRAINT agent_task_batch_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY agent_task_runs
    ADD CONSTRAINT agent_task_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY agent_task_schedules
    ADD CONSTRAINT agent_task_schedules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY annotation_queues
    ADD CONSTRAINT annotation_queues_pkey PRIMARY KEY (id);
ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY call_metrics
    ADD CONSTRAINT call_metrics_pkey PRIMARY KEY (id);
ALTER TABLE ONLY comment_reactions
    ADD CONSTRAINT comment_reactions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY github_connections
    ADD CONSTRAINT github_connections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY logged_calls
    ADD CONSTRAINT logged_calls_pkey PRIMARY KEY (row_id);
ALTER TABLE ONLY model_definitions
    ADD CONSTRAINT model_definitions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY otlp_ingest_batches
    ADD CONSTRAINT otlp_ingest_batches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY otlp_spans
    ADD CONSTRAINT otlp_spans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY project_invitations
    ADD CONSTRAINT project_invitations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_pkey PRIMARY KEY (id);
ALTER TABLE ONLY project_task_inventory
    ADD CONSTRAINT project_task_inventory_pkey PRIMARY KEY (id);
ALTER TABLE ONLY project_task_sources
    ADD CONSTRAINT project_task_sources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);
ALTER TABLE ONLY run_metrics
    ADD CONSTRAINT run_metrics_pkey PRIMARY KEY (id);
ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (row_id);
ALTER TABLE ONLY score_configs
    ADD CONSTRAINT score_configs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY call_metrics
    ADD CONSTRAINT uq_call_metrics_scope UNIQUE (project, call_id, metric_name, metric_type);
ALTER TABLE ONLY comment_reactions
    ADD CONSTRAINT uq_comment_reaction UNIQUE (comment_id, emoji, user_id);
ALTER TABLE ONLY logged_calls
    ADD CONSTRAINT uq_logged_calls_project_span UNIQUE (project, id);
ALTER TABLE ONLY otlp_spans
    ADD CONSTRAINT uq_otlp_span UNIQUE (project_id, trace_id, span_id);
ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT uq_project_membership UNIQUE (project_id, user_id);
ALTER TABLE ONLY run_metrics
    ADD CONSTRAINT uq_run_metrics_scope UNIQUE (project, run_id, metric_name, metric_type);
ALTER TABLE ONLY runs
    ADD CONSTRAINT uq_runs_project_trace UNIQUE (project, id);
ALTER TABLE ONLY score_configs
    ADD CONSTRAINT uq_score_config_project_name UNIQUE (project, name);
ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);
CREATE INDEX idx_adaptive_task_states_next_run ON adaptive_task_states USING btree (next_run_at);
CREATE INDEX idx_adaptive_task_states_schedule ON adaptive_task_states USING btree (schedule_id);
CREATE INDEX idx_agent_task_batch_runs_trace_persistence_status ON agent_task_batch_runs USING btree (trace_persistence_status);
CREATE INDEX idx_agent_task_runs_task_inventory_id ON agent_task_runs USING btree (task_inventory_id);
CREATE INDEX idx_agent_task_runs_trace_persistence_status ON agent_task_runs USING btree (trace_persistence_status);
CREATE INDEX idx_calls_internal_model_id ON logged_calls USING btree (internal_model_id);
CREATE INDEX idx_calls_observation_type ON logged_calls USING btree (observation_type);
CREATE INDEX idx_calls_parent_call_id ON logged_calls USING btree (parent_call_id);
CREATE INDEX idx_calls_prompt_id ON logged_calls USING btree (prompt_id);
CREATE INDEX idx_calls_session_id ON logged_calls USING btree (session_id);
CREATE INDEX idx_calls_tool_name ON logged_calls USING btree (tool_name);
CREATE INDEX idx_runs_environment ON runs USING btree (environment);
CREATE INDEX idx_runs_external_id ON runs USING btree (external_id);
CREATE INDEX idx_runs_session_id ON runs USING btree (session_id);
CREATE INDEX idx_sessions_created_at ON sessions USING btree (created_at);
CREATE INDEX idx_sessions_environment ON sessions USING btree (environment);
CREATE INDEX idx_sessions_user_id ON sessions USING btree (user_id);
CREATE INDEX ix_adaptive_task_states_next_run_at ON adaptive_task_states USING btree (next_run_at);
CREATE INDEX ix_adaptive_task_states_schedule_id ON adaptive_task_states USING btree (schedule_id);
CREATE INDEX ix_agent_task_batch_runs_project ON agent_task_batch_runs USING btree (project);
CREATE INDEX ix_agent_task_batch_runs_selection_type ON agent_task_batch_runs USING btree (selection_type);
CREATE INDEX ix_agent_task_batch_runs_status ON agent_task_batch_runs USING btree (status);
CREATE INDEX ix_agent_task_batch_runs_trace_persistence_status ON agent_task_batch_runs USING btree (trace_persistence_status);
CREATE INDEX ix_agent_task_runs_batch_run_id ON agent_task_runs USING btree (batch_run_id);
CREATE INDEX ix_agent_task_runs_status ON agent_task_runs USING btree (status);
CREATE INDEX ix_agent_task_runs_task_id ON agent_task_runs USING btree (task_id);
CREATE INDEX ix_agent_task_runs_task_inventory_id ON agent_task_runs USING btree (task_inventory_id);
CREATE INDEX ix_agent_task_runs_trace_persistence_status ON agent_task_runs USING btree (trace_persistence_status);
CREATE INDEX ix_agent_task_schedules_cadence_type ON agent_task_schedules USING btree (cadence_type);
CREATE INDEX ix_agent_task_schedules_enabled ON agent_task_schedules USING btree (enabled);
CREATE INDEX ix_agent_task_schedules_project ON agent_task_schedules USING btree (project);
CREATE INDEX ix_agent_task_schedules_selection_type ON agent_task_schedules USING btree (selection_type);
CREATE INDEX ix_annotation_queues_is_active ON annotation_queues USING btree (is_active);
CREATE INDEX ix_annotation_queues_name ON annotation_queues USING btree (name);
CREATE INDEX ix_annotation_queues_project ON annotation_queues USING btree (project);
CREATE INDEX ix_annotation_queues_score_config_id ON annotation_queues USING btree (score_config_id);
CREATE INDEX ix_annotation_queues_target_type ON annotation_queues USING btree (target_type);
CREATE INDEX ix_api_keys_created_by ON api_keys USING btree (created_by);
CREATE INDEX ix_api_keys_hashed_key ON api_keys USING btree (hashed_key);
CREATE UNIQUE INDEX ix_api_keys_hashed_secret_key ON api_keys USING btree (hashed_secret_key);
CREATE INDEX ix_api_keys_prefix ON api_keys USING btree (prefix);
CREATE INDEX ix_api_keys_project ON api_keys USING btree (project);
CREATE UNIQUE INDEX ix_api_keys_public_key ON api_keys USING btree (public_key);
CREATE INDEX ix_call_metrics_call_id ON call_metrics USING btree (call_id);
CREATE INDEX ix_call_metrics_config_id ON call_metrics USING btree (config_id);
CREATE INDEX ix_call_metrics_metric_name ON call_metrics USING btree (metric_name);
CREATE INDEX ix_call_metrics_metric_type ON call_metrics USING btree (metric_type);
CREATE INDEX ix_call_metrics_project ON call_metrics USING btree (project);
CREATE INDEX ix_call_metrics_source ON call_metrics USING btree (source);
CREATE INDEX ix_comment_reactions_comment_id ON comment_reactions USING btree (comment_id);
CREATE INDEX ix_comment_reactions_user_id ON comment_reactions USING btree (user_id);
CREATE INDEX ix_comments_object_id ON comments USING btree (object_id);
CREATE INDEX ix_comments_object_type ON comments USING btree (object_type);
CREATE INDEX ix_comments_project_id ON comments USING btree (project_id);
CREATE UNIQUE INDEX ix_email_verification_tokens_code_hash ON email_verification_tokens USING btree (code_hash);
CREATE INDEX ix_email_verification_tokens_user_id ON email_verification_tokens USING btree (user_id);
CREATE INDEX ix_github_connections_github_user_id ON github_connections USING btree (github_user_id);
CREATE UNIQUE INDEX ix_github_connections_project ON github_connections USING btree (project);
CREATE INDEX ix_logged_calls_cost ON logged_calls USING btree (cost);
CREATE INDEX ix_logged_calls_created_at ON logged_calls USING btree (created_at);
CREATE INDEX ix_logged_calls_flow_name ON logged_calls USING btree (flow_name);
CREATE INDEX ix_logged_calls_id ON logged_calls USING btree (id);
CREATE INDEX ix_logged_calls_latency_ms ON logged_calls USING btree (latency_ms);
CREATE INDEX ix_logged_calls_parent_call_id ON logged_calls USING btree (parent_call_id);
CREATE INDEX ix_logged_calls_project ON logged_calls USING btree (project);
CREATE INDEX ix_logged_calls_prompt_id ON logged_calls USING btree (prompt_id);
CREATE INDEX ix_logged_calls_run_id ON logged_calls USING btree (run_id);
CREATE INDEX ix_logged_calls_session_id ON logged_calls USING btree (session_id);
CREATE INDEX ix_logged_calls_task_id ON logged_calls USING btree (task_id);
CREATE INDEX ix_logged_calls_version ON logged_calls USING btree (version);
CREATE INDEX ix_model_definitions_match_pattern ON model_definitions USING btree (match_pattern);
CREATE INDEX ix_model_definitions_model_name ON model_definitions USING btree (model_name);
CREATE INDEX ix_model_definitions_project ON model_definitions USING btree (project);
CREATE INDEX ix_model_definitions_provider ON model_definitions USING btree (provider);
CREATE INDEX ix_otlp_ingest_batches_project_id ON otlp_ingest_batches USING btree (project_id);
CREATE INDEX ix_otlp_ingest_batches_status ON otlp_ingest_batches USING btree (status);
CREATE INDEX ix_otlp_ingest_batches_verified_task_run_id ON otlp_ingest_batches USING btree (verified_task_run_id);
CREATE INDEX ix_otlp_spans_parent_span_id ON otlp_spans USING btree (parent_span_id);
CREATE INDEX ix_otlp_spans_project_id ON otlp_spans USING btree (project_id);
CREATE INDEX ix_otlp_spans_span_id ON otlp_spans USING btree (span_id);
CREATE INDEX ix_otlp_spans_trace ON otlp_spans USING btree (project_id, trace_id);
CREATE INDEX ix_otlp_spans_trace_id ON otlp_spans USING btree (trace_id);
CREATE UNIQUE INDEX ix_password_reset_tokens_token_hash ON password_reset_tokens USING btree (token_hash);
CREATE INDEX ix_password_reset_tokens_user_id ON password_reset_tokens USING btree (user_id);
CREATE INDEX ix_project_invitations_accepted_at ON project_invitations USING btree (accepted_at);
CREATE INDEX ix_project_invitations_email ON project_invitations USING btree (email);
CREATE INDEX ix_project_invitations_expires_at ON project_invitations USING btree (expires_at);
CREATE INDEX ix_project_invitations_invited_by_user_id ON project_invitations USING btree (invited_by_user_id);
CREATE INDEX ix_project_invitations_project_id ON project_invitations USING btree (project_id);
CREATE INDEX ix_project_invitations_revoked_at ON project_invitations USING btree (revoked_at);
CREATE INDEX ix_project_invitations_role ON project_invitations USING btree (role);
CREATE UNIQUE INDEX ix_project_invitations_token_hash ON project_invitations USING btree (token_hash);
CREATE INDEX ix_project_memberships_project_id ON project_memberships USING btree (project_id);
CREATE INDEX ix_project_memberships_role ON project_memberships USING btree (role);
CREATE INDEX ix_project_memberships_user_id ON project_memberships USING btree (user_id);
CREATE INDEX ix_project_task_inventory_project ON project_task_inventory USING btree (project);
CREATE INDEX ix_project_task_inventory_task_id ON project_task_inventory USING btree (task_id);
CREATE INDEX ix_project_task_inventory_task_source_id ON project_task_inventory USING btree (task_source_id);
CREATE UNIQUE INDEX ix_project_task_sources_project ON project_task_sources USING btree (project);
CREATE INDEX ix_project_task_sources_source_type ON project_task_sources USING btree (source_type);
CREATE INDEX ix_project_task_sources_status ON project_task_sources USING btree (status);
CREATE INDEX ix_projects_created_by ON projects USING btree (created_by);
CREATE INDEX ix_projects_name ON projects USING btree (name);
CREATE INDEX ix_run_metrics_config_id ON run_metrics USING btree (config_id);
CREATE INDEX ix_run_metrics_metric_name ON run_metrics USING btree (metric_name);
CREATE INDEX ix_run_metrics_metric_type ON run_metrics USING btree (metric_type);
CREATE INDEX ix_run_metrics_project ON run_metrics USING btree (project);
CREATE INDEX ix_run_metrics_run_id ON run_metrics USING btree (run_id);
CREATE INDEX ix_run_metrics_source ON run_metrics USING btree (source);
CREATE INDEX ix_runs_bookmarked ON runs USING btree (bookmarked);
CREATE INDEX ix_runs_environment ON runs USING btree (environment);
CREATE INDEX ix_runs_external_id ON runs USING btree (external_id);
CREATE INDEX ix_runs_flow_name ON runs USING btree (flow_name);
CREATE INDEX ix_runs_id ON runs USING btree (id);
CREATE INDEX ix_runs_is_public ON runs USING btree (is_public);
CREATE INDEX ix_runs_primary_model ON runs USING btree (primary_model);
CREATE INDEX ix_runs_project ON runs USING btree (project);
CREATE INDEX ix_runs_session_id ON runs USING btree (session_id);
CREATE INDEX ix_runs_task_id ON runs USING btree (task_id);
CREATE UNIQUE INDEX ix_runs_task_run_id ON runs USING btree (task_run_id);
CREATE INDEX ix_runs_version ON runs USING btree (version);
CREATE INDEX ix_score_configs_data_type ON score_configs USING btree (data_type);
CREATE INDEX ix_score_configs_is_archived ON score_configs USING btree (is_archived);
CREATE INDEX ix_score_configs_name ON score_configs USING btree (name);
CREATE INDEX ix_score_configs_project ON score_configs USING btree (project);
CREATE INDEX ix_sessions_environment ON sessions USING btree (environment);
CREATE INDEX ix_sessions_project ON sessions USING btree (project);
CREATE INDEX ix_sessions_user_id ON sessions USING btree (user_id);
CREATE UNIQUE INDEX ix_users_email ON users USING btree (email);
CREATE INDEX ix_users_is_active ON users USING btree (is_active);
CREATE INDEX ix_webhooks_enabled ON webhooks USING btree (enabled);
CREATE INDEX ix_webhooks_project ON webhooks USING btree (project);
CREATE UNIQUE INDEX uq_project_invitations_active_email ON project_invitations USING btree (project_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));
CREATE UNIQUE INDEX ux_runs_task_run_id ON runs USING btree (task_run_id);
ALTER TABLE ONLY adaptive_task_states
    ADD CONSTRAINT adaptive_task_states_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES agent_task_schedules(id);
ALTER TABLE ONLY agent_task_runs
    ADD CONSTRAINT agent_task_runs_batch_run_id_fkey FOREIGN KEY (batch_run_id) REFERENCES agent_task_batch_runs(id);
ALTER TABLE ONLY annotation_queues
    ADD CONSTRAINT annotation_queues_score_config_id_fkey FOREIGN KEY (score_config_id) REFERENCES score_configs(id);
ALTER TABLE ONLY call_metrics
    ADD CONSTRAINT call_metrics_config_id_fkey FOREIGN KEY (config_id) REFERENCES score_configs(id);
ALTER TABLE ONLY comment_reactions
    ADD CONSTRAINT comment_reactions_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES comments(id);
ALTER TABLE ONLY email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE ONLY github_connections
    ADD CONSTRAINT github_connections_project_fkey FOREIGN KEY (project) REFERENCES projects(id);
ALTER TABLE ONLY password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE ONLY project_invitations
    ADD CONSTRAINT project_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES users(id);
ALTER TABLE ONLY project_invitations
    ADD CONSTRAINT project_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES users(id);
ALTER TABLE ONLY project_invitations
    ADD CONSTRAINT project_invitations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE ONLY project_task_inventory
    ADD CONSTRAINT project_task_inventory_project_fkey FOREIGN KEY (project) REFERENCES projects(id);
ALTER TABLE ONLY project_task_inventory
    ADD CONSTRAINT project_task_inventory_task_source_id_fkey FOREIGN KEY (task_source_id) REFERENCES project_task_sources(id);
ALTER TABLE ONLY project_task_sources
    ADD CONSTRAINT project_task_sources_project_fkey FOREIGN KEY (project) REFERENCES projects(id);
ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE ONLY run_metrics
    ADD CONSTRAINT run_metrics_config_id_fkey FOREIGN KEY (config_id) REFERENCES score_configs(id);
