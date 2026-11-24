package shop;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class NoticeController {
    private final NoticeRepo repo;
    private final Notifier notifier;

    public NoticeController(NoticeRepo repo, Notifier notifier) {
        this.repo = repo;
        this.notifier = notifier;
    }

    @PostMapping("/notices")
    public void create(Notice notice) {
        repo.save(notice);
        notifier.send(notice);
    }
}
