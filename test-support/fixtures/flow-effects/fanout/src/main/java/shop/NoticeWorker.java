package shop;

import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;

@Component
public class NoticeWorker {
    private final NoticeQueue queue;
    private final Notifier notifier;

    public NoticeWorker(NoticeQueue queue, Notifier notifier) {
        this.queue = queue;
        this.notifier = notifier;
    }

    @PostConstruct
    public void start() {
        while (true) {
            Notice notice = queue.take();
            notifier.send(notice);
        }
    }
}
