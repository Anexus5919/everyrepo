CREATE TABLE `cluster` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`module_id` integer,
	`label` text NOT NULL,
	`file_count` integer NOT NULL,
	`token_count` integer NOT NULL,
	`top_files` text NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `module`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cluster_key_unique` ON `cluster` (`key`);--> statement-breakpoint
CREATE TABLE `edge` (
	`src_file_id` integer NOT NULL,
	`dst_file_id` integer NOT NULL,
	`kind` text NOT NULL,
	`weight` real NOT NULL,
	PRIMARY KEY(`src_file_id`, `dst_file_id`, `kind`),
	FOREIGN KEY (`src_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dst_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `edge_dst` ON `edge` (`dst_file_id`);--> statement-breakpoint
CREATE TABLE `file_import` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`specifier` text NOT NULL,
	`kind` text NOT NULL,
	`names` text,
	`line` integer NOT NULL,
	`resolution` text,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_import_file` ON `file_import` (`file_id`);--> statement-breakpoint
ALTER TABLE `file` ADD `package_name` text;--> statement-breakpoint
ALTER TABLE `file` ADD `pagerank` real;--> statement-breakpoint
ALTER TABLE `file` ADD `cluster_id` integer;