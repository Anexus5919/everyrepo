CREATE TABLE `file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`oid` text NOT NULL,
	`bytes` integer NOT NULL,
	`tokens` integer NOT NULL,
	`language` text,
	`kind` text NOT NULL,
	`module_id` integer,
	`parse_status` text DEFAULT 'skipped' NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `module`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_path_unique` ON `file` (`path`);--> statement-breakpoint
CREATE INDEX `file_module` ON `file` (`module_id`);--> statement-breakpoint
CREATE INDEX `file_kind` ON `file` (`kind`);--> statement-breakpoint
CREATE TABLE `module` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`license` text,
	`parent_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_path_unique` ON `module` (`path`);--> statement-breakpoint
CREATE TABLE `snapshot` (
	`sha` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`ref` text NOT NULL,
	`engine_version` text NOT NULL,
	`size_tier` text,
	`source_tokens` integer,
	`stats` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_ref` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`line` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `symbol_ref_file` ON `symbol_ref` (`file_id`);--> statement-breakpoint
CREATE INDEX `symbol_ref_name` ON `symbol_ref` (`name`);--> statement-breakpoint
CREATE TABLE `symbol` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`exported` integer NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`signature` text NOT NULL,
	`doc` text,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `symbol_file` ON `symbol` (`file_id`);--> statement-breakpoint
CREATE INDEX `symbol_name` ON `symbol` (`name`);