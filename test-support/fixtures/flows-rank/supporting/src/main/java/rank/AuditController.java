package rank;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuditController {
    private final AuditRepo repo;

    public AuditController(AuditRepo repo) {
        this.repo = repo;
    }

    @PostMapping("/audit")
    public void write(AuditRow row) {
        repo.save(row);
    }
}
