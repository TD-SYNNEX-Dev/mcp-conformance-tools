import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { ScreenStage } from "./ScreenStage";

describe("ScreenStage", () => {
  it("renders its screen when active", () => {
    renderWithMantine(
      <ScreenStage active>
        <div>active screen</div>
      </ScreenStage>,
    );
    expect(screen.getByText("active screen")).toBeInTheDocument();
  });

  it("renders nothing when inactive (outgoing screen unmounts)", () => {
    renderWithMantine(
      <ScreenStage active={false}>
        <div>inactive screen</div>
      </ScreenStage>,
    );
    expect(screen.queryByText("inactive screen")).toBeNull();
  });

  it("still renders its screen in the fill variant", () => {
    renderWithMantine(
      <ScreenStage active fill>
        <div>filled screen</div>
      </ScreenStage>,
    );
    expect(screen.getByText("filled screen")).toBeInTheDocument();
  });
});

function Draft() {
  const [text, setText] = useState("");
  return (
    <input
      aria-label="Draft"
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
    />
  );
}

it("preserves a draft across navigation when keepMounted is enabled", async () => {
  const { rerender } = renderWithMantine(
    <ScreenStage active keepMounted>
      <Draft />
    </ScreenStage>,
  );
  await userEvent.type(screen.getByLabelText("Draft"), "work in progress");
  rerender(
    <ScreenStage active={false} keepMounted>
      <Draft />
    </ScreenStage>,
  );
  expect(screen.getByLabelText("Draft")).not.toBeVisible();
  rerender(
    <ScreenStage active keepMounted>
      <Draft />
    </ScreenStage>,
  );
  expect(screen.getByLabelText("Draft")).toHaveValue("work in progress");
});
