import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";

interface DialogueState {
  inside: boolean;
  nextKey: number;
}

function formatDialogue(children: ReactNode, state: DialogueState): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return child.split(/(")/).map((part) => {
        if (!part) return part;
        if (part === '"') state.inside = !state.inside;
        return state.inside || part === '"' ? (
          <span className="story-dialogue" key={`dialogue-${state.nextKey++}`}>
            {part}
          </span>
        ) : (
          part
        );
      });
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    if (
      typeof child.type === "string" &&
      ["blockquote", "code", "ol", "p", "pre", "ul"].includes(child.type)
    ) {
      return child;
    }
    const nested = child.props.children;
    return nested === undefined || nested === null
      ? child
      : cloneElement(child, {}, formatDialogue(nested, state));
  });
}

function formatBlock(children: ReactNode): ReactNode {
  return formatDialogue(children, { inside: false, nextKey: 0 });
}

const STORY_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h3>{formatBlock(children)}</h3>,
  h2: ({ children }) => <h4>{formatBlock(children)}</h4>,
  h3: ({ children }) => <h5>{formatBlock(children)}</h5>,
  h4: ({ children }) => <h6>{formatBlock(children)}</h6>,
  h5: ({ children }) => <h6>{formatBlock(children)}</h6>,
  h6: ({ children }) => <h6>{formatBlock(children)}</h6>,
  p: ({ children }) => <p>{formatBlock(children)}</p>,
  li: ({ children }) => <li>{formatBlock(children)}</li>,
  img: ({ alt }) => <span>{alt}</span>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export const StoryMarkdown = memo(function StoryMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <div className="story-prose">
      <Markdown components={STORY_MARKDOWN_COMPONENTS}>{content}</Markdown>
    </div>
  );
});
