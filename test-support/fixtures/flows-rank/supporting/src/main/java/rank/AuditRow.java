package rank;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class AuditRow {
    @Id
    private Long id;
}
