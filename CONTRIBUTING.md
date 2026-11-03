# Contributing

Thanks for taking a look at the project.

## Before opening a pull request

- Use Node.js 22 or newer.
- Run `npm ci`.
- Run `npx tsc --noEmit`.
- Run `npm run check`.
- Test the affected flow locally with `npm run dev`.
- Do not include `.dev.vars`, database dumps, screenshots of real conversations,
  personal contact details, or production credentials.

## Commit messages

Keep commits focused and describe the user-visible change. Chinese commit
messages are welcome.

## Security and privacy

Do not open a public issue for a vulnerability. Follow `SECURITY.md`.

Do not add real user messages, images, email addresses, phone numbers, or
WeChat contact details to tests, fixtures, or screenshots. Use synthetic data.

## License

By contributing code, you agree that it is licensed under the repository's MIT
License. Site copy and visual identity are not automatically licensed for
reuse.
