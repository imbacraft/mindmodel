package shop;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Contract {
    @Id
    private Long id;
    private Long voucherId;

    public Contract(Long voucherId) {
        this.voucherId = voucherId;
    }
}
