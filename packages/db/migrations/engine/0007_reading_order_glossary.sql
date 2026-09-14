CREATE TABLE `glossary_term` (
	`term` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`citations` text NOT NULL,
	`pages` text NOT NULL,
	`model` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `wiki_page` ADD `reading_order` text;