package shop;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Notice {
    @Id
    private Long id;

    private String body;
}
