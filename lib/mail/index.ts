import { emailProvider, graphConfig, smtpConfig } from "./config";
import { createGraphProvider } from "./graph";
import { createSmtpProvider } from "./smtp";
import { MAIL_DISABLED_MESSAGE, MailError, type MailProvider } from "./types";

export * from "./types";
export { emailProvider, senderAddress } from "./config";
export { buildEml } from "./eml";

/** EMAIL_PROVIDER=none: nothing is ever sent. The preview and the .eml download still work. */
export function createNoneProvider(): MailProvider {
  return {
    name: "none",
    supportsInlineImages: false,
    async send() {
      throw new MailError(MAIL_DISABLED_MESSAGE, "disabled");
    },
  };
}

/**
 * The provider chosen by EMAIL_PROVIDER (smtp | graph | none, default none). Its settings are validated
 * here, when it is first used, so an install that never sends needs none of them.
 */
export function getMailProvider(source: Record<string, string | undefined> = process.env): MailProvider {
  switch (emailProvider(source)) {
    case "smtp":
      return createSmtpProvider(smtpConfig(source));
    case "graph":
      return createGraphProvider(graphConfig(source));
    default:
      return createNoneProvider();
  }
}
