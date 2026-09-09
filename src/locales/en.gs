const EN = Object.freeze({
  actions: {confirm: 'Confirm', ignore: 'Ignore', retry_ai: 'Retry with AI'},
  statuses: {confirmed: 'Imported', review: 'Needs review', ignored: 'Ignored'},
  summarySubject: 'MyCoupons: import summary',
  summaryBody: 'New imports: {imported}\nNew review items: {review}\nErrors: {errors}{links}',
  yes: 'Yes',
  imported: 'New imports', review: 'Review items', errors: 'Errors',
  source: 'Source email', row: 'Open row', reviewHelp: 'Edit uncertain fields, then select an action in Action needed.',
  needsReview: 'Check the source email before confirming.',
  retryMismatch: 'AI returned a different candidate set. Review the source and edit this row manually.',
  incomplete: 'Some content could not be inspected. Check the original email.',
  error: 'Processing failed ({code}). Correct the cause and retry.',
  errorCodes: {
    CONFIG: 'Invalid or incomplete configuration.', OWNER: 'The authenticated owner does not match the installation.',
    RESOURCE: 'Resource identity or headers do not match. Check configuration.',
    INITIAL_DATE: 'An empty sheet requires an explicit initial date before scanning.',
    DATE: 'A real coupon row has an invalid email date. Correct it before recovering history.',
    AI: 'AI is unavailable or returned an invalid response.', AI_HTTP: 'The AI request failed.',
    AI_KEY: 'Configure the Gemini API key in Script Properties.',
    WRITE: 'Sheet verification failed. The email has not been archived.',
    REVIEW: 'Check merchant and coupon code, discount, or voucher link before confirming.',
    STATE: 'The processing journal is inconsistent. Restore it before resuming.',
    MAIL: 'The Gmail update could not be verified. It will be retried.',
    LIMIT: 'The message exceeds the processing limits. Review it manually.',
    PREFLIGHT: 'Verify both AI backends and installation before enabling automation.',
    BUSY: 'Another execution is active. Retry shortly.',
    INTERNAL: 'Processing failed. Check the installation and retry.'
  }
});
