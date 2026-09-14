import Markdown from "@/common/components/Markdown";
import "./styles.sass";

/** Chat bubbles render the same Markdown as the rest of the app, with the chat's tighter spacing. */
export const MessageContent = ({ text }) => <Markdown text={text} className="message-content" />;
