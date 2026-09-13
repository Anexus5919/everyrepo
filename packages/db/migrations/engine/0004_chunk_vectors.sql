CREATE TABLE `chunk_vector` (
	`chunk_id` integer PRIMARY KEY NOT NULL,
	`vector` blob NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunk`(`id`) ON UPDATE no action ON DELETE cascade
);
