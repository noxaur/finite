import { useParams } from "react-router";

export default function User() {
  const { userId } = useParams();
  return <h1 className="text-xl">User {userId}</h1>;
}
