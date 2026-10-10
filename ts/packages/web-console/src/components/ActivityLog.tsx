// The connection's activity as sentences with their times, and the raw frame log behind a toggle for debugging.

import { useState } from "react";
import { Switch, Table, Text } from "@mantine/core";
import type { FrameLogEntry } from "wire-mesh-core/domain/mesh-session";
import type { ActivityEntry } from "../activity.js";
import { PeerName } from "./PeerName.js";

function describeRawFrame(frame: unknown): string {
  return JSON.stringify(frame, (_key: string, value: unknown): unknown =>
    value instanceof Uint8Array ? `<${String(value.byteLength)} bytes>` : value,
  );
}

export interface ActivityLogProps {
  activity: readonly ActivityEntry[];
  frameLog: readonly FrameLogEntry[];
}

export function ActivityLog({
  activity,
  frameLog,
}: Readonly<ActivityLogProps>): React.JSX.Element {
  const [raw, setRaw] = useState(false);

  return (
    <>
      <Switch
        mt="md"
        label="Show raw frames"
        checked={raw}
        onChange={(event) => {
          setRaw(event.currentTarget.checked);
        }}
      />
      {raw ? (
        <Table.ScrollContainer minWidth={0} h={384} data-testid="frame-log">
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>direction</Table.Th>
                <Table.Th>frame</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {frameLog.map((entry, index) => (
                <Table.Tr key={index}>
                  <Table.Td>{entry.direction}</Table.Td>
                  <Table.Td>{describeRawFrame(entry.frame)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <>
          <Text fw={600} size="sm" mt="md">
            Activity
          </Text>
          {activity.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing has happened yet.
            </Text>
          ) : (
            <Table.ScrollContainer
              minWidth={0}
              h={384}
              data-testid="activity-log"
            >
              <Table>
                <Table.Tbody>
                  {[...activity].reverse().map((entry) => (
                    <Table.Tr key={entry.key}>
                      <Table.Td>
                        {new Date(entry.at).toLocaleTimeString()}
                      </Table.Td>
                      <Table.Td>
                        {entry.summary}
                        {entry.peer !== undefined && (
                          <>
                            {" "}
                            <PeerName deviceHex={entry.peer} />
                          </>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </>
      )}
    </>
  );
}
