package shop;

import java.util.ArrayDeque;
import java.util.Deque;

/** A project queue: the worker polls it, and its type name is what says so. */
public class NoticeQueue {
    private final Deque<Notice> pending = new ArrayDeque<>();

    public Notice take() {
        return pending.poll();
    }

    public void add(Notice notice) {
        pending.add(notice);
    }
}
