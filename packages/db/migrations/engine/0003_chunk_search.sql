CREATE VIRTUAL TABLE `chunk_fts` USING fts5(
	header,
	content,
	identifiers,
	content = 'chunk',
	content_rowid = 'id',
	tokenize = 'unicode61 remove_diacritics 2'
);
