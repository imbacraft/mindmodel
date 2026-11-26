package shop;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import lombok.Builder;

// Lombok's builder is nested in the entity as `Booking.BookingBuilder`: a status set through it is a set of Booking's.
@Entity
@Builder
public class Booking {
    @Id
    private Long id;
    private OrderStatus status;
}
